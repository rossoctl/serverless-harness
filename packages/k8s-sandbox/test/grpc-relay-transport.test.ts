import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { runConformance, type FakeBehavior, type TransportFactory } from './conformance.js';
import { GrpcRelayTransport, type ExecClientLike } from '../src/grpc-relay-transport.js';
import { DEFAULT_EXEC_TIMEOUT_S } from '../src/transport.js';
import {
  Stream,
  type AbortRequest,
  type ExecEvent,
  type ExecRequest,
} from '../src/gen/sandbox/v1/sandbox.js';

/** Build a fake ExecClientLike that scripts a FakeBehavior onto ExecEvent frames. */
function fakeClient(behavior: FakeBehavior): {
  client: ExecClientLike;
  stdinSeen: () => Buffer | undefined;
  aborted: () => number[];
  reqIdSeen: () => number | undefined;
} {
  let stdin: Buffer | undefined;
  let lastReqId: number | undefined;
  const aborted: number[] = [];
  const client: ExecClientLike = {
    exec(request: ExecRequest) {
      stdin = request.exec ? Buffer.from(request.exec.stdin) : undefined;
      const reqId = request.exec?.reqId ?? 0;
      lastReqId = reqId;
      const stream = new EventEmitter() as EventEmitter & { cancel: () => void };
      stream.cancel = () => {};
      // Emit scripted frames on the next tick so listeners attach first.
      queueMicrotask(() => {
        if (behavior.hang) return; // never completes
        for (const s of behavior.stdout ?? [])
          stream.emit('data', {
            chunk: { reqId, data: Buffer.from(s), stream: Stream.STREAM_STDOUT },
          } as ExecEvent);
        for (const s of behavior.stderr ?? [])
          stream.emit('data', {
            chunk: { reqId, data: Buffer.from(s), stream: Stream.STREAM_STDERR },
          } as ExecEvent);
        stream.emit('data', { end: { reqId, exitCode: behavior.exitCode ?? 0 } } as ExecEvent);
        stream.emit('end');
      });
      return stream;
    },
    abort(request: AbortRequest, cb: (err: Error | null) => void) {
      aborted.push(request.reqId);
      cb(null);
      return {};
    },
  };
  return { client, stdinSeen: () => stdin, aborted: () => aborted, reqIdSeen: () => lastReqId };
}

const grpcFactory: TransportFactory = (behavior, opts) => {
  const { client, stdinSeen, aborted, reqIdSeen } = fakeClient(behavior);
  const transport = GrpcRelayTransport('sbx-1', client, { outputCapBytes: opts?.outputCapBytes });
  return {
    transport,
    stdinSeen,
    // On this wire, stopping the producer means an Abort naming the exec's own req_id —
    // the relay routes the abort by that id, so an Abort for any other id would leave the
    // flood running. Correlate rather than just counting calls.
    producerStop: () => {
      const id = reqIdSeen();
      return id !== undefined && aborted().includes(id) ? 'remote-abort' : 'none';
    },
  };
};

runConformance('GrpcRelayTransport', grpcFactory, { producerStop: 'remote-abort', streams: true });

function manualClient() {
  let stream!: EventEmitter & { cancel: () => void };
  // The transport draws reqId from a salted per-process source (shared with every
  // other exec() call made earlier in this test file, e.g. the runConformance
  // battery above), so the id it actually uses is an unpredictable salt-plus-counter
  // value, not a literal we can predict. Capture it from the request
  // GrpcRelayTransport hands to exec() so assertions can compare against the
  // real id instead of guessing it.
  let lastReqId: number | undefined;
  let lastTimeoutS: number | undefined;
  const aborted: number[] = [];
  const client = {
    exec(request?: { exec?: { reqId: number; timeoutS?: number } }) {
      lastReqId = request?.exec?.reqId;
      lastTimeoutS = request?.exec?.timeoutS;
      stream = Object.assign(new EventEmitter(), { cancel: () => {} });
      return stream;
    },
    abort(req: { reqId: number }, cb: (e: Error | null) => void) {
      aborted.push(req.reqId);
      cb(null);
      return {};
    },
  };
  return {
    client,
    emit: (ev: ExecEvent) => stream.emit('data', ev),
    aborted: () => aborted,
    reqId: () => lastReqId,
    timeoutS: () => lastTimeoutS,
  };
}

describe('GrpcRelayTransport extra semantics', () => {
  // The shared battery pins what the CALLER observes, which cannot distinguish a ceiling both
  // ends enforce from one only we do. These three pin the wire value, because the difference
  // only shows up when the harness is no longer around to enforce its own timer: the worker
  // arms a timeout solely when timeout_s > 0 (remote-worker/internal/exec/runner.go), so a 0
  // here means a dropped connection or a dead harness leaves the remote process running
  // forever -- the slot leak DEFAULT_EXEC_TIMEOUT_S exists to prevent (#182).
  it('sends the shared ceiling as timeout_s when the caller names no timeout', async () => {
    const { client, timeoutS } = manualClient();
    const t = GrpcRelayTransport('sbx-1', client as never);
    void t.exec('sleep 999').catch(() => {});
    expect(timeoutS()).toBe(DEFAULT_EXEC_TIMEOUT_S);
  });

  it("sends the caller's own timeout_s verbatim when one is given", async () => {
    const { client, timeoutS } = manualClient();
    const t = GrpcRelayTransport('sbx-1', client as never);
    void t.exec('sleep 999', { timeout: 7 }).catch(() => {});
    expect(timeoutS()).toBe(7);
  });

  it('sends 0 for an explicit timeout: 0, so unbounded stays unbounded on both ends', async () => {
    const { client, timeoutS } = manualClient();
    const t = GrpcRelayTransport('sbx-1', client as never);
    void t.exec('sleep 999', { timeout: 0 }).catch(() => {});
    expect(timeoutS()).toBe(0);
  });

  it("the cap's Abort names the exec's own req_id", async () => {
    // The shared battery only asks "was the producer stopped". Here we pin the wire
    // detail the battery cannot express portably: the relay routes an Abort by req_id,
    // so an Abort carrying any other id would leave the flood running at full rate
    // while this exec has already stopped reading (spec §8).
    const { client, emit, aborted, reqId } = manualClient();
    const t = GrpcRelayTransport('sbx-1', client as never, { outputCapBytes: 6 });
    const p = t.exec('cat big');
    await Promise.resolve(); // let exec() register its handlers
    emit({
      chunk: { reqId: reqId()!, data: Buffer.from('aaaabbbb'), stream: Stream.STREAM_STDOUT },
    } as ExecEvent);
    const r = await p;
    expect(r.stdout.toString()).toContain('[output truncated]');
    expect(aborted()).toContain(reqId());
  });

  it('dedups: a late End for a settled reqId is dropped', async () => {
    const { client, emit } = manualClient();
    const t = GrpcRelayTransport('sbx-1', client as never);
    const p = t.exec('echo hi');
    emit({
      chunk: { reqId: 1, data: Buffer.from('hi'), stream: Stream.STREAM_STDOUT },
    } as ExecEvent);
    emit({ end: { reqId: 1, exitCode: 0 } } as ExecEvent);
    const r = await p;
    expect(r.stdout.toString()).toBe('hi');
    // A duplicate terminal frame after settlement must not throw or change the result.
    expect(() => emit({ end: { reqId: 1, exitCode: 9 } } as ExecEvent)).not.toThrow();
  });

  it('harness deadline fires independently of worker timeout_s', async () => {
    vi.useFakeTimers();
    const { client } = manualClient();
    const t = GrpcRelayTransport('sbx-1', client as never, { deadlineMs: 500 });
    const p = t.exec('sleep 999'); // no exec opts.timeout ⇒ deadlineMs governs
    const assertion = expect(p).rejects.toThrow(/^timeout:/);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    vi.useRealTimers();
  });

  it('close() closes the underlying gRPC channel via client.close()', async () => {
    const { client } = manualClient();
    const closeSpy = vi.fn();
    (client as unknown as { close: () => void }).close = closeSpy;
    const t = GrpcRelayTransport('sbx-1', client as never);
    await t.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('close() is idempotent: calling it twice closes the channel at most once', async () => {
    const { client } = manualClient();
    const closeSpy = vi.fn();
    (client as unknown as { close: () => void }).close = closeSpy;
    const t = GrpcRelayTransport('sbx-1', client as never);
    await t.close();
    await t.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('close() is a safe no-op when the client exposes no close() (scripted fakes)', async () => {
    const { client } = manualClient(); // manualClient's fake has no `close` method
    const t = GrpcRelayTransport('sbx-1', client as never);
    await expect(t.close()).resolves.toBeUndefined();
  });
});
