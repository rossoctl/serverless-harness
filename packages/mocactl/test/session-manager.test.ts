import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/errors.js';
import type { TurnFrame } from '../src/api/frames.js';
import {
  HarnessUntrustedError,
  SessionManager,
  type SessionDeps,
  type SessionEvent,
} from '../src/core/session-manager.js';
import { TranscriptStore } from '../src/core/transcripts.js';
import { doneFrame, fakeControlPlane, fakeHarness, type HarnessStep } from './helpers/fakes.js';

const NOW = 1_000_000_000; // ms
const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(steps: HarnessStep[], over: Partial<SessionDeps> = {}) {
  const cp = fakeControlPlane();
  const harness = fakeHarness(steps);
  const slept: number[] = [];
  const deps: SessionDeps = {
    cp,
    harness,
    now: () => NOW,
    sleep: async (ms) => void slept.push(ms),
    ...over,
  };
  return { cp, harness, slept, deps, manager: new SessionManager(deps) };
}

async function started(steps: HarnessStep[], over: Partial<SessionDeps> = {}) {
  const s = setup(steps, over);
  const session = await s.manager.resume('s1');
  const events: SessionEvent[] = [];
  session.on((e) => events.push(e));
  return { ...s, session, events, ends: () => events.filter((e) => e.kind === 'turn-end') };
}

const harnessError = (status: number, code: string, retryAfterS?: number) =>
  new ApiError('harness', status, code, undefined, retryAfterS);

describe('ActiveSession', () => {
  it('runs a turn and forwards its frames', async () => {
    const { session, events } = await started([
      { frames: [{ type: 'text', delta: 'hi' }, doneFrame()] },
    ]);
    session.submit('hello');
    await session.idle();
    expect(events.map((e) => e.kind)).toEqual([
      'queue',
      'queue',
      'turn-start',
      'frame',
      'frame',
      'turn-end',
    ]);
    expect(events.at(-1)).toEqual({ kind: 'turn-end', outcome: 'done' });
  });

  it('runs one turn at a time, in submission order', async () => {
    const { session, harness, events } = await started([
      { frames: [doneFrame()] },
      { frames: [doneFrame()] },
    ]);
    session.submit('a');
    session.submit('b');
    await session.idle();
    expect(harness.turns.map((t) => t.prompt)).toEqual(['a', 'b']);
    expect(
      events.filter((e) => e.kind === 'turn-start').map((e) => (e as { prompt: string }).prompt),
    ).toEqual(['a', 'b']);
  });

  it('queues a prompt submitted while a turn is streaming; cancel moves on to it', async () => {
    const { session, ends } = await started(
      [{ frames: [{ type: 'text', delta: 'x' }], hang: true }],
      { cancelPauseMs: 5 },
    );
    session.submit('a');
    await tick();
    session.submit('b');
    expect(session.busy).toBe(true);
    expect(session.queued).toBe(1);
    session.cancel();
    await session.idle();
    expect(ends().map((e) => (e as { outcome: string }).outcome)).toEqual(['cancelled', 'done']);
  });

  it('clearQueue drops waiting prompts', async () => {
    const { session, harness } = await started([{ hang: true }]);
    session.submit('a');
    await tick();
    session.submit('b');
    session.clearQueue();
    session.cancel();
    await session.idle();
    expect(harness.turns.map((t) => t.prompt)).toEqual(['a']);
  });

  it('after a cancel, waits before sending the next queued prompt, so a clearQueue drops it', async () => {
    const { session, harness, ends } = await started([{ hang: true }], { cancelPauseMs: 10_000 });
    session.submit('a');
    await tick();
    session.submit('b');
    session.cancel();
    await tick();
    await tick();
    expect(ends().map((e) => (e as { outcome: string }).outcome)).toEqual(['cancelled']);
    expect(harness.turns.map((t) => t.prompt)).toEqual(['a']); // 'b' is waiting, not sent
    expect(session.queued).toBe(1);
    session.clearQueue(); // the second Esc, within the window
    await session.idle(); // ends the pause at once: no 10 s wait
    expect(harness.turns.map((t) => t.prompt)).toEqual(['a']);
  });

  it('after a cancel, sends the next queued prompt once the pause has passed', async () => {
    const { session, harness, ends } = await started([{ hang: true }], { cancelPauseMs: 30 });
    session.submit('a');
    await tick();
    session.submit('b');
    const cancelledAt = Date.now();
    session.cancel();
    await session.idle();
    expect(Date.now() - cancelledAt).toBeGreaterThanOrEqual(25);
    expect(harness.turns.map((t) => t.prompt)).toEqual(['a', 'b']);
    expect(ends().map((e) => (e as { outcome: string }).outcome)).toEqual(['cancelled', 'done']);
  });

  it('does not pause after a turn that finished normally', async () => {
    const { session, harness } = await started([{ frames: [doneFrame()] }], {
      cancelPauseMs: 10_000,
    });
    session.submit('a');
    session.submit('b');
    await session.idle();
    expect(harness.turns.map((t) => t.prompt)).toEqual(['a', 'b']);
  });

  it('remints a session token that is inside the 30 s margin', async () => {
    let mints = 0;
    const s = setup([]);
    s.cp.mintSessionToken = async () =>
      mints++ === 0
        ? { token: 'near', expiresAt: NOW / 1000 + 10 }
        : { token: 'renewed', expiresAt: NOW / 1000 + 300 };
    const session = await s.manager.resume('s1');
    session.submit('p');
    await session.idle();
    expect(mints).toBe(2); // resume, then the pre-turn remint
    expect(s.harness.turns[0].token).toBe('renewed');
  });

  it('remints once on a harness token rejection and succeeds', async () => {
    const { session, cp, ends } = await started([
      { error: harnessError(401, 'token_invalid') },
      { frames: [doneFrame()] },
    ]);
    session.submit('p');
    await session.idle();
    expect(cp.calls.filter((c) => c === 'mintSessionToken')).toHaveLength(2); // resume + one remint
    expect(ends()).toEqual([{ kind: 'turn-end', outcome: 'done' }]);
  });

  it('token_expired from the harness remints once and succeeds', async () => {
    const { session, ends } = await started([
      { error: harnessError(401, 'token_expired') },
      { frames: [doneFrame()] },
    ]);
    session.submit('p');
    await session.idle();
    expect(ends()).toEqual([{ kind: 'turn-end', outcome: 'done' }]);
  });

  it('diagnoses an untrusted harness when a fresh token is rejected again', async () => {
    const { session, ends } = await started([
      { error: harnessError(401, 'token_invalid') },
      { error: harnessError(401, 'token_invalid') },
    ]);
    session.submit('p');
    await session.idle();
    const end = ends()[0] as { outcome: string; error?: Error };
    expect(end.outcome).toBe('error');
    expect(end.error).toBeInstanceOf(HarnessUntrustedError);
  });

  it('waits out Retry-After on a 503 and retries', async () => {
    const { session, slept, events } = await started([
      { error: harnessError(503, 'saturated', 4) },
      { frames: [doneFrame()] },
    ]);
    session.submit('p');
    await session.idle();
    expect(slept).toEqual([4000]);
    expect(events).toContainEqual({ kind: 'retrying', seconds: 4 });
    expect(events.at(-1)).toEqual({ kind: 'turn-end', outcome: 'done' });
  });

  it('cancel during a Retry-After wait ends the turn as cancelled', async () => {
    const waitForAbort = (_ms: number, signal?: AbortSignal) =>
      new Promise<void>((r) => signal?.addEventListener('abort', () => r(), { once: true }));
    const { session, ends } = await started([{ error: harnessError(503, 'saturated', 60) }], {
      sleep: waitForAbort,
    });
    session.submit('p');
    await tick();
    await tick();
    session.cancel();
    await session.idle();
    expect(ends()).toEqual([{ kind: 'turn-end', outcome: 'cancelled' }]);
  });

  it('a truncated stream ends the turn as an error and the queue continues', async () => {
    const truncated = new ApiError(
      'harness',
      0,
      'stream_truncated',
      'the harness closed the stream before the turn finished',
    );
    const { session, cp, ends } = await started([
      { frames: [{ type: 'text', delta: 'part' }], error: truncated },
      { frames: [doneFrame()] },
    ]);
    session.submit('a');
    session.submit('b');
    await session.idle();
    expect(ends().map((e) => (e as { outcome: string }).outcome)).toEqual(['error', 'done']);
    expect((ends()[0] as { error?: Error }).error).toBe(truncated);
    expect(cp.calls.filter((c) => c === 'mintSessionToken')).toHaveLength(1); // no remint after frames flowed
    expect(session.busy).toBe(false);
  });

  it('reports an error frame as an error outcome with its message', async () => {
    const { session, ends } = await started([
      {
        frames: [
          { type: 'error', sessionId: 's1', stopReason: 'error', errorMessage: 'model refused' },
        ],
      },
    ]);
    session.submit('p');
    await session.idle();
    expect((ends()[0] as { error?: Error }).error?.message).toBe('model refused');
  });

  it('records the prompt and frames in the transcript store', async () => {
    const transcripts = new TranscriptStore(mkdtempSync(join(tmpdir(), 'mocactl-sm-')), {
      subject: 'github:1',
      controlPlaneUrl: 'http://cp',
    });
    const { session } = await started([{ frames: [{ type: 'text', delta: 'ok' }, doneFrame()] }], {
      transcripts,
    });
    session.submit('hello');
    await session.idle();
    expect(transcripts.load('s1')!.entries.map((e) => e.kind)).toEqual([
      'prompt',
      'frame',
      'frame',
    ]);
  });
});

describe('SessionManager', () => {
  it('create uses the token from the create response and ensures a transcript', async () => {
    const transcripts = new TranscriptStore(mkdtempSync(join(tmpdir(), 'mocactl-sm-')), {
      subject: 'github:1',
      controlPlaneUrl: 'http://cp',
    });
    const { manager, cp, harness } = setup([], { transcripts });
    const session = await manager.create({ credentials: { inference: 'a' } });
    expect(session.sessionId).toBe('s-new');
    expect(transcripts.has('s-new')).toBe(true);
    session.submit('p');
    await session.idle();
    expect(harness.turns[0].token).toBe('st');
    expect(cp.calls).not.toContain('mintSessionToken');
  });

  it('remove deletes the session and its transcript', async () => {
    const transcripts = new TranscriptStore(mkdtempSync(join(tmpdir(), 'mocactl-sm-')), {
      subject: 'github:1',
      controlPlaneUrl: 'http://cp',
    });
    transcripts.appendPrompt('s1', 'x');
    const { manager } = setup([], { transcripts });
    expect(await manager.remove('s1')).toBe('deleted');
    expect(transcripts.has('s1')).toBe(false);
  });

  it('a control-plane mint failure during remint ends the turn as error', async () => {
    const cpError = new ApiError('control-plane', 401, 'token_expired');
    const { session, cp, ends } = await started([{ error: harnessError(401, 'token_invalid') }]);
    cp.mintSessionToken = async () => {
      throw cpError;
    };
    session.submit('p');
    await session.idle();
    expect(ends()[0]).toEqual({ kind: 'turn-end', outcome: 'error', error: cpError });
  });

  it('session_mismatch twice throws the ApiError, not HarnessUntrustedError', async () => {
    const mismatchError = harnessError(400, 'session_mismatch');
    const { session, ends } = await started([{ error: mismatchError }, { error: mismatchError }]);
    session.submit('p');
    await session.idle();
    const end = ends()[0] as { outcome: string; error?: Error };
    expect(end.outcome).toBe('error');
    expect(end.error).toBe(mismatchError);
  });

  it('a 503 with Retry-After that arrives after a frame has flowed is not retried', async () => {
    const { session, slept, ends } = await started([
      { frames: [{ type: 'text', delta: 'x' }], error: harnessError(503, 'saturated', 2) },
    ]);
    session.submit('p');
    await session.idle();
    expect(slept).toEqual([]); // No sleep because streamed=true blocks retry
    expect(ends()[0]?.outcome).toBe('error');
    expect(ends()[0]?.error).toBeDefined();
  });

  it('with a real TranscriptStore, a truncated stream leaves the pending text delta', async () => {
    const truncated = new ApiError(
      'harness',
      0,
      'stream_truncated',
      'the harness closed the stream',
    );
    const transcripts = new TranscriptStore(mkdtempSync(join(tmpdir(), 'mocactl-sm-')), {
      subject: 'github:1',
      controlPlaneUrl: 'http://cp',
    });
    const { session } = await started(
      [{ frames: [{ type: 'text', delta: 'part' }], error: truncated }],
      { transcripts },
    );
    session.submit('a');
    await session.idle();
    const t = transcripts.load('s1')!;
    // Entries include prompt and the buffered text frame (flushed on error)
    expect(t.entries.map((e) => e.kind)).toEqual(['prompt', 'frame']);
    // Frame entry should be the text delta
    const textFrameEntry = t.entries[1] as { kind: 'frame'; frame: TurnFrame };
    expect(textFrameEntry.frame.type).toBe('text');
    expect((textFrameEntry.frame as { type: string; delta: string }).delta).toBe('part');
  });

  it('a listener that throws on every event does not break the session', async () => {
    const { session, ends } = await started([{ frames: [doneFrame()] }, { frames: [doneFrame()] }]);
    const throwingListener = () => {
      throw new Error('listener crash');
    };
    const goodEvents: SessionEvent[] = [];
    const goodListener = (e: SessionEvent) => {
      goodEvents.push(e);
    };
    session.on(throwingListener);
    session.on(goodListener);
    session.submit('a');
    session.submit('b');
    await session.idle();
    // Both turns should complete with exactly one turn-end each, despite throwing listener
    const turnEnds = goodEvents.filter((e) => e.kind === 'turn-end');
    expect(turnEnds).toHaveLength(2);
    expect(turnEnds.map((e) => (e as { outcome: string }).outcome)).toEqual(['done', 'done']);
  });

  it('a TranscriptStore whose appendPrompt throws does not crash the turn', async () => {
    const badTranscripts = {
      appendPrompt: () => {
        throw new Error('disk full');
      },
    } as unknown as TranscriptStore;
    const { session, ends } = await started([{ frames: [doneFrame()] }], {
      transcripts: badTranscripts,
    });
    session.submit('p');
    await session.idle();
    expect(ends()).toEqual([{ kind: 'turn-end', outcome: 'done' }]);
  });
});
