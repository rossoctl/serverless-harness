import { ApiError, TurnCancelledError, errorFromResponse, networkError } from './errors.js';
import { isTerminal, type TurnFrame } from './frames.js';
import { readSse, toFrame } from './sse-parser.js';
import type { HarnessApi, StreamTurnArgs } from './types.js';

export class HarnessClient implements HarnessApi {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  async baseUrl(): Promise<string> {
    return this.base;
  }

  async health(): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/health`, { method: 'GET' });
    } catch (err) {
      throw networkError('harness', err);
    }
    if (!res.ok) throw await errorFromResponse('harness', res);
  }

  async *streamTurn({
    sessionId,
    prompt,
    token,
    signal,
  }: StreamTurnArgs): AsyncGenerator<TurnFrame> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/v1/turn`, {
        method: 'POST',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ sessionId, prompt }),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw new TurnCancelledError();
      throw networkError('harness', err);
    }
    if (!res.ok) throw await errorFromResponse('harness', res);

    // A harness (or proxy) that ignores Accept answers with the sync JSON body; render it rather
    // than fail.
    if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const r = (await res.json()) as {
        sessionId?: string;
        response?: string;
        stopReason?: string;
        errorMessage?: string;
      };
      if (r.response) yield { type: 'text', delta: r.response };
      const stopReason = r.stopReason ?? 'end_turn';
      yield r.errorMessage || (stopReason !== 'end_turn' && stopReason !== 'max_tokens')
        ? {
            type: 'error',
            sessionId: r.sessionId ?? sessionId,
            stopReason,
            errorMessage: r.errorMessage,
          }
        : { type: 'done', sessionId: r.sessionId ?? sessionId, stopReason };
      return;
    }
    if (!res.body)
      throw new ApiError('harness', 0, 'stream_truncated', 'the harness returned no stream');

    try {
      for await (const event of readSse(res.body)) {
        const frame = toFrame(event);
        yield frame;
        if (isTerminal(frame)) return;
      }
    } catch (err) {
      if (signal?.aborted) throw new TurnCancelledError();
      throw networkError('harness', err);
    }
    if (signal?.aborted) throw new TurnCancelledError();
    throw new ApiError(
      'harness',
      0,
      'stream_truncated',
      'the harness closed the stream before the turn finished',
    );
  }

  /**
   * Whether this harness verifies this control plane's session tokens, without running a turn.
   * The body names a DIFFERENT session than the token: a harness that verifies the token refuses it
   * with session_mismatch before the credential exchange or any model call (turn-auth.ts). A harness
   * without the keyset answers token_invalid; one with no token handling at all falls through to
   * session_not_found or runs the turn.
   */
  async probeTrust(token: string, sessionId: string): Promise<'trusted' | 'untrusted'> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/v1/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          sessionId: `${sessionId}-mocactl-probe`,
          prompt: 'mocactl trust probe',
        }),
      });
    } catch (err) {
      throw networkError('harness', err);
    }
    if (res.status === 400) {
      const err = await errorFromResponse('harness', res);
      if (err.code === 'session_mismatch') return 'trusted';
      throw err;
    }
    if (res.status === 401 || res.status === 404 || res.ok) {
      await res.body?.cancel();
      return 'untrusted';
    }
    throw await errorFromResponse('harness', res);
  }
}
