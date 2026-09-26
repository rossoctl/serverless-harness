import { ApiError, TOKEN_CODES, TurnCancelledError } from '../api/errors.js';
import { isTerminal, type TurnFrame } from '../api/frames.js';
import type {
  ControlPlaneApi,
  CreateSessionRequest,
  HarnessApi,
  SessionToken,
} from '../api/types.js';
import type { TranscriptStore } from './transcripts.js';

export class HarnessUntrustedError extends Error {
  constructor() {
    super(
      'the harness rejected a freshly minted session token — it is likely missing MU1 auth configuration. Run doctor for details: `/doctor` in the app, or `mocactl doctor`.',
    );
    this.name = 'HarnessUntrustedError';
  }
}

/**
 * How long a second Esc has to clear the queue: after a cancelled turn, the next queued prompt
 * waits this long before it is sent, so a double Esc never dispatches it first.
 */
export const DOUBLE_ESC_MS = 1000;

export type SessionEvent =
  | { kind: 'turn-start'; prompt: string }
  | { kind: 'frame'; frame: TurnFrame }
  | { kind: 'retrying'; seconds: number }
  | { kind: 'turn-end'; outcome: 'done' | 'error' | 'cancelled'; error?: Error }
  | { kind: 'queue'; size: number };

export interface SessionDeps {
  cp: ControlPlaneApi;
  harness: HarnessApi;
  transcripts?: TranscriptStore;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  remintMarginS?: number;
  /** The pause after a cancelled turn before the queue drains on (default DOUBLE_ESC_MS; 0: none). */
  cancelPauseMs?: number;
}

export class ActiveSession {
  private readonly listeners = new Set<(e: SessionEvent) => void>();
  private queue: Array<{ prompt: string; resend: boolean }> = [];
  private controller?: AbortController;
  private running = false;
  private idleWaiters: Array<() => void> = [];
  private endPause?: () => void;

  constructor(
    private readonly deps: SessionDeps,
    readonly sessionId: string,
    private token: SessionToken,
  ) {}

  on(listener: (e: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get busy(): boolean {
    return this.running;
  }

  get queued(): number {
    return this.queue.length;
  }

  // The server does not serialize concurrent turns of one session (spec §2.6); this queue does.
  // A resend (the replay after a re-login) runs a prompt the transcript already holds, so it is
  // not recorded again.
  submit(prompt: string, opts: { resend?: boolean } = {}): void {
    this.queue.push({ prompt, resend: opts.resend === true });
    this.emit({ kind: 'queue', size: this.queue.length });
    void this.drain().catch(() => undefined);
  }

  cancel(): void {
    this.controller?.abort();
  }

  clearQueue(): void {
    this.queue = [];
    this.emit({ kind: 'queue', size: 0 });
    this.endPause?.(); // nothing is left to wait for
  }

  idle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private emit(e: SessionEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // Ignore listener errors; they should not break the session
      }
    }
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const { prompt, resend } = this.queue.shift()!;
        this.emit({ kind: 'queue', size: this.queue.length });
        const cancelled = await this.runTurn(prompt, resend);
        if (cancelled && this.queue.length > 0 && this.deps.cancelPauseMs !== 0) await this.pause();
      }
    } finally {
      this.running = false;
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    }
  }

  private pause(): Promise<void> {
    return new Promise((resolve) => {
      const end = () => {
        clearTimeout(timer);
        this.endPause = undefined;
        resolve();
      };
      const timer = setTimeout(end, this.deps.cancelPauseMs ?? DOUBLE_ESC_MS);
      this.endPause = end;
    });
  }

  private async ensureToken(): Promise<void> {
    const marginMs = (this.deps.remintMarginS ?? 30) * 1000;
    if (this.token.expiresAt * 1000 - this.deps.now() < marginMs) {
      this.token = await this.deps.cp.mintSessionToken(this.sessionId);
    }
  }

  private transcriptSafe(fn: () => void): void {
    try {
      fn();
    } catch {
      // Ignore errors from transcript store; it's a display cache only
    }
  }

  /** Resolves true when the turn ended cancelled. */
  private async runTurn(prompt: string, resend = false): Promise<boolean> {
    const controller = new AbortController();
    this.controller = controller;
    if (!resend)
      this.transcriptSafe(() => this.deps.transcripts?.appendPrompt(this.sessionId, prompt));
    this.emit({ kind: 'turn-start', prompt });
    let reminted = false;
    let streamed = false;
    try {
      for (;;) {
        await this.ensureToken();
        try {
          const frames = this.deps.harness.streamTurn({
            sessionId: this.sessionId,
            prompt,
            token: this.token.token,
            signal: controller.signal,
          });
          for await (const frame of frames) {
            streamed = true;
            this.transcriptSafe(() => this.deps.transcripts?.appendFrame(this.sessionId, frame));
            this.emit({ kind: 'frame', frame });
            if (isTerminal(frame)) {
              this.emit(
                frame.type === 'done'
                  ? { kind: 'turn-end', outcome: 'done' }
                  : {
                      kind: 'turn-end',
                      outcome: 'error',
                      error: new Error(frame.errorMessage ?? frame.stopReason),
                    },
              );
              return false;
            }
          }
          // Stream ended without a terminal frame; emit error
          this.emit({
            kind: 'turn-end',
            outcome: 'error',
            error: new Error('the harness ended the turn without a result'),
          });
          return false;
        } catch (err) {
          if (controller.signal.aborted || err instanceof TurnCancelledError)
            throw new TurnCancelledError();
          // Once frames have flowed the status code is spent; never re-send a half-run turn.
          if (!(err instanceof ApiError) || err.source !== 'harness' || streamed) throw err;
          if (TOKEN_CODES.has(err.code) || err.code === 'session_mismatch') {
            // One remint covers an expired token and client/server clock skew. A token rejected
            // seconds after minting means the harness does not trust this control plane (§8.2).
            if (!reminted) {
              reminted = true;
              this.token = await this.deps.cp.mintSessionToken(this.sessionId);
              continue;
            }
            throw err.code === 'session_mismatch' ? err : new HarnessUntrustedError();
          }
          if (err.status === 503 && err.retryAfterS !== undefined) {
            this.emit({ kind: 'retrying', seconds: err.retryAfterS });
            await this.deps.sleep(err.retryAfterS * 1000, controller.signal);
            if (controller.signal.aborted) throw new TurnCancelledError();
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      this.transcriptSafe(() => this.deps.transcripts?.flush(this.sessionId));
      if (controller.signal.aborted || err instanceof TurnCancelledError) {
        this.emit({ kind: 'turn-end', outcome: 'cancelled' });
        return true;
      }
      this.emit({ kind: 'turn-end', outcome: 'error', error: err as Error });
      return false;
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }
}

export class SessionManager {
  constructor(private readonly deps: SessionDeps) {}

  async create(req: CreateSessionRequest): Promise<ActiveSession> {
    const created = await this.deps.cp.createSession(req);
    this.deps.transcripts?.ensure(created.sessionId);
    return new ActiveSession(this.deps, created.sessionId, {
      token: created.token,
      expiresAt: created.expiresAt,
    });
  }

  async resume(sessionId: string): Promise<ActiveSession> {
    return new ActiveSession(this.deps, sessionId, await this.deps.cp.mintSessionToken(sessionId));
  }

  async remove(sessionId: string): Promise<'deleted' | 'accepted'> {
    const result = await this.deps.cp.deleteSession(sessionId);
    this.deps.transcripts?.delete(sessionId);
    return result;
  }
}
