import { describe, it, expect } from 'vitest';
import { harness, fakeSocket } from './helpers/fake-worker.js';

describe('WorkerPool lifecycle', () => {
  it('forks the configured number of workers, none healthy until ready', () => {
    const h = harness({}, 3);
    expect(h.forked).toHaveLength(3);
    // A worker that has not sent `ready` has not built its handler server yet. Routing to it
    // would hand a socket to a process with no parser attached.
    expect(h.pool.views().every((v) => v.healthy)).toBe(false);
    h.forked[0]!.ready();
    expect(h.pool.views()[0]).toEqual({ id: 0, inFlight: 0, healthy: true });
  });

  it('reconciles the estimate from load, in both directions', () => {
    const h = harness();
    h.forked[0]!.ready();
    h.pool.handOff(0, fakeSocket());
    expect(h.pool.views()[0]!.inFlight).toBe(1); // optimistic
    h.forked[0]!.load(4);
    expect(h.pool.views()[0]!.inFlight).toBe(4); // worker is the authority (§3.9)
    h.forked[0]!.load(0);
    expect(h.pool.views()[0]!.inFlight).toBe(0);
  });

  it('counts over-admission when load lands ABOVE the estimate', () => {
    // §3.9's first stale case: a second turn on a kept-alive socket the supervisor already
    // handed off. Self-correcting, but E8 must be able to see it in the data.
    const h = harness();
    h.forked[0]!.ready();
    h.pool.handOff(0, fakeSocket());
    h.forked[0]!.load(3);
    expect(h.pool.counters.overAdmission).toBe(1);
    expect(h.logs).toContainEqual(
      expect.objectContaining({ event: 'over_admission', id: 0, estimate: 1, actual: 3 }),
    );
    // A load that merely confirms the estimate is not an event.
    h.forked[0]!.load(3);
    expect(h.pool.counters.overAdmission).toBe(1);
  });

  it('stops routing to a draining worker without killing it', () => {
    const h = harness();
    h.forked[0]!.ready();
    h.forked[1]!.ready();
    h.forked[0]!.draining();
    expect(h.pool.views()[0]!.healthy).toBe(false);
    expect(h.forked[0]!.killed).toBeUndefined(); // in-flight turns must finish
  });

  it('records a stats message as advisory telemetry, never in views()', () => {
    // Before pool.ts grew the `stats` branch, `WorkerPool` had no `telemetry()` method, so
    // this failed to compile ("telemetry is not a function") rather than throwing at runtime
    // -- the right kind of RED per GC2.
    const h = harness();
    h.forked[0]!.ready();
    h.forked[0]!.stats({ loopLagP99Ms: 12.5, rssBytes: 90_000_000 });
    expect(h.pool.telemetry()[0]).toEqual(
      expect.objectContaining({ loopLagP99Ms: 12.5, rssBytes: 90_000_000 }),
    );
    // Advisory: `views()` is the whole of what a routing policy sees, and it must not change.
    expect(h.pool.views()[0]).toEqual({ id: 0, inFlight: 0, healthy: true });
  });

  it('ignores an unrecognised IPC message', () => {
    const h = harness();
    h.forked[0]!.ready();
    h.forked[0]!.load(3);
    expect(h.pool.views()[0]!.inFlight).toBe(3);
    // Off-contract on purpose: a worker from a different build sending a type this union does
    // not know. No `@ts-expect-error` here -- `FakeWorker.emit` is inherited straight from
    // `EventEmitter` (`emit(eventName: string | symbol, ...args: any[]): boolean`), which does
    // not check its payload against `WorkerToSupervisor`, so there is no type error to suppress.
    h.forked[0]!.emit('message', { type: 'from-the-future' });
    expect(h.pool.views()[0]!.inFlight).toBe(3); // unchanged -- an unknown type must be inert
    expect(h.pool.views()[0]!.healthy).toBe(true);
    expect(h.logs.some((l) => l.event === 'crash')).toBe(false);
  });
});

describe('WorkerPool hand-off', () => {
  it('sends the socket as a handle, with the head base64-encoded', () => {
    const h = harness();
    h.forked[0]!.ready();
    const took = h.pool.handOff(0, fakeSocket(), Buffer.from('POST /turn HTTP/1.1\r\n'));
    expect(took).toBe(0);
    expect(h.forked[0]!.sent[0]).toEqual({
      msg: { type: 'conn', head: Buffer.from('POST /turn HTTP/1.1\r\n').toString('base64') },
      hasHandle: true,
    });
  });

  it('omits head entirely on the default path', () => {
    const h = harness();
    h.forked[0]!.ready();
    h.pool.handOff(0, fakeSocket());
    expect(h.forked[0]!.sent[0]!.msg).toEqual({ type: 'conn' });
  });

  it('does NOT retry a worker whose send() returned false while still delivering', () => {
    // THE regression pin for the hand-off double-delivery defect. Node's `send()` returns
    // false for a queued handle it will still deliver (measured: the third and later handle
    // sent inside one tick), so treating the boolean as failure retries a socket that has
    // already been handed over. Because the fd hand-off is destructive, exactly one worker
    // then gets the descriptor and the other receives a `conn` with no handle -- which used
    // to kill it, taking every turn it was multiplexing. Any burst of >=3 connections to one
    // worker in one tick reproduces it, which is precisely what E8's ladder generates.
    const h = harness();
    h.forked[0]!.ready();
    h.forked[1]!.ready();
    h.forked[0]!.sendReturnsFalse = true;
    const sock = fakeSocket();
    const took = h.pool.handOff(0, sock);
    expect(took).toBe(0);
    // Exactly one worker receives the socket, and it is the one we picked.
    expect(h.forked[0]!.conns).toBe(1);
    expect(h.forked[1]!.conns).toBe(0);
    // Credited, or worker 0's estimate is stale LOW -- §3.9's dangerous direction, and
    // unbounded rather than one-per-worker.
    expect(h.pool.views()[0]!.inFlight).toBe(1);
    // Ordinary backpressure is not a retry, and must not inflate the counter E8 reads.
    expect(h.pool.counters.handoffRetries).toBe(0);
    expect(sock.destroy).not.toHaveBeenCalled();
  });

  it('retries the next-least-loaded when the chosen worker is already gone', () => {
    // §6's hand-off race. The window between pick and send is real and cannot be closed
    // without a synchronous round trip, which §3.9 refuses. A DISCONNECTED channel is a real
    // failure signal, unlike a `false` return.
    const h = harness();
    h.forked[0]!.ready();
    h.forked[1]!.ready();
    h.forked[0]!.connected = false;
    const took = h.pool.handOff(0, fakeSocket());
    expect(took).toBe(1);
    expect(h.forked[1]!.conns).toBe(1);
    // Nothing was even attempted on the dead channel: the pool consulted `connected`.
    expect(h.forked[0]!.conns).toBe(0);
    expect(h.pool.counters.handoffRetries).toBe(1);
    // The failed attempt must not leave a phantom turn on worker 0's estimate.
    expect(h.pool.views()[0]!.inFlight).toBe(0);
  });

  it('retries when send() THROWS, the other real failure signal', () => {
    // A channel that closes between the `connected` check and the send raises
    // ERR_IPC_CHANNEL_CLOSED. That must be caught and retried, not thrown out of handOff()
    // into the connection callback.
    const h = harness();
    h.forked[0]!.ready();
    h.forked[1]!.ready();
    h.forked[0]!.sendThrows = true;
    expect(h.pool.handOff(0, fakeSocket())).toBe(1);
    expect(h.forked[1]!.conns).toBe(1);
    expect(h.pool.counters.handoffRetries).toBe(1);
    expect(h.pool.views()[0]!.inFlight).toBe(0);
  });

  it('closes the socket rather than leaking it when nobody can take it', () => {
    // The alternative — returning undefined and forgetting the socket — leaks a fd per
    // occurrence, and on a saturation ladder that is the leak that ends the run.
    const h = harness();
    h.forked[0]!.ready();
    h.forked[1]!.ready();
    h.forked[0]!.connected = false;
    h.forked[1]!.sendThrows = true;
    const sock = fakeSocket();
    expect(h.pool.handOff(0, sock)).toBeUndefined();
    expect(sock.destroy).toHaveBeenCalled();
    expect(h.pool.counters.handoffFailures).toBe(1);
  });
});

describe('WorkerPool restart', () => {
  it('marks the worker unhealthy and re-forks after the backoff', () => {
    const h = harness({ restartBackoffMs: 250 });
    h.forked[0]!.ready();
    h.forked[0]!.exit(1);
    expect(h.pool.views()[0]!.healthy).toBe(false);
    expect(h.timers.map((t) => t.ms)).toEqual([250]);
    h.runTimers();
    expect(h.forked).toHaveLength(3);
    // The replacement takes the same id, so W is stable and E8's per-worker series line up.
    h.forked[2]!.ready();
    expect(h.pool.views()[0]).toEqual({ id: 0, inFlight: 0, healthy: true });
    expect(h.pool.counters.restarts).toBe(1);
  });

  it('backs off exponentially while it keeps crashing', () => {
    const h = harness({ restartBackoffMs: 250 });
    for (let i = 0; i < 3; i += 1) {
      h.forked.at(-1)!.exit(1);
      h.runTimers();
    }
    // A crash loop that re-forks every 250ms burns a core doing nothing and drowns the log.
    expect(h.logs.filter((l) => l.event === 'worker_exit').map((l) => l.restartInMs)).toEqual([
      250, 500, 1000,
    ]);
  });

  it('resets the exponent after a run that actually lasted', () => {
    const h = harness({ restartBackoffMs: 250, healthyRunMs: 10_000 });
    h.forked[0]!.exit(1);
    h.runTimers();
    h.clock.t = 60_000; // this incarnation stayed up a minute
    h.forked.at(-1)!.exit(1);
    expect(h.logs.filter((l) => l.event === 'worker_exit').map((l) => l.restartInMs)).toEqual([
      250, 250,
    ]);
  });

  it('does not resurrect a DRAINED worker on a stray ready', () => {
    // Nothing guarded `ready` against arriving after `draining` had set the slot unhealthy --
    // a late or duplicate `ready` from a worker that is finishing its last turns would put it
    // back in the routing set, and the pool would hand it new connections while it is shutting
    // down. A drained slot stays unhealthy for good.
    const h = harness();
    h.forked[0]!.ready();
    h.pool.drainAll();
    h.forked[0]!.draining();
    expect(h.pool.views()[0]!.healthy).toBe(false);
    h.forked[0]!.ready();
    expect(h.pool.views()[0]!.healthy).toBe(false);
  });

  it('does not resurrect a worker that exited during drain', () => {
    // On SIGTERM the whole set is going away; re-forking would fight the shutdown.
    const h = harness();
    h.forked[0]!.ready();
    h.pool.drainAll();
    h.forked[0]!.exit(0);
    expect(h.timers).toHaveLength(0);
    expect(h.forked).toHaveLength(2);
  });
});

describe('WorkerPool head-truncation accounting', () => {
  it('counts a truncated head, so a cap hit is never invisible', () => {
    // A cap hit costs the connection its session affinity. Unrecorded, that shows up on E8's
    // sticky arm as a low hit rate with nothing in the data separating it from a genuine null
    // result -- a measurement effect indistinguishable from the measurement.
    const h = harness();
    expect(h.pool.counters.headTruncations).toBe(0);
    h.pool.noteHeadTruncated(9000);
    h.pool.noteHeadTruncated(9000);
    expect(h.pool.counters.headTruncations).toBe(2);
    expect(h.logs).toContainEqual(
      expect.objectContaining({ event: 'head_truncated', bytes: 9000 }),
    );
  });
});

describe('WorkerPool refusal accounting', () => {
  it('convicts a refusal that the next load shows was unnecessary', () => {
    // §3.9's dangerous direction: the estimate was stale HIGH, so the 429 refused
    // concurrency the pool could have served — which truncates E8's rungs and makes the
    // knee read early with nothing in the data to distinguish it from a real ceiling.
    const h = harness();
    h.forked[0]!.ready();
    h.forked[1]!.ready();
    h.forked[0]!.load(4);
    h.forked[1]!.load(4);
    h.pool.noteRefusal();
    h.forked[0]!.load(1); // it had already finished three turns when we refused
    expect(h.pool.counters.spuriousRefusals).toBe(1);
    expect(h.logs).toContainEqual(
      expect.objectContaining({ event: 'refusal_reconciled', id: 0, estimate: 4, actual: 1 }),
    );
  });

  it('counts each refusal at most once, however many workers report lower', () => {
    const h = harness();
    h.forked[0]!.ready();
    h.forked[1]!.ready();
    h.forked[0]!.load(4);
    h.forked[1]!.load(4);
    h.pool.noteRefusal();
    h.forked[0]!.load(0);
    h.forked[1]!.load(0);
    expect(h.pool.counters.spuriousRefusals).toBe(1);
  });

  it('leaves a genuine refusal uncounted', () => {
    const h = harness();
    h.forked[0]!.ready();
    h.forked[1]!.ready();
    h.forked[0]!.load(4);
    h.forked[1]!.load(4);
    h.pool.noteRefusal();
    h.forked[0]!.load(4); // still full: the pool really was saturated
    h.forked[1]!.load(5);
    expect(h.pool.counters.spuriousRefusals).toBe(0);
  });
});

describe('WorkerPool drain', () => {
  it('sends drain once per worker and is idempotent', () => {
    const h = harness();
    h.forked[0]!.ready();
    h.forked[1]!.ready();
    h.pool.drainAll();
    h.pool.drainAll();
    for (const w of h.forked) {
      expect(w.sent.filter((s) => s.msg.type === 'drain')).toEqual([
        { msg: { type: 'drain' }, hasHandle: false },
      ]);
    }
  });

  it('awaitIdle resolves at once when no worker has a turn in flight', async () => {
    const h = harness();
    h.forked[0]!.ready();
    h.forked[1]!.ready();
    await expect(h.pool.awaitIdle(50)).resolves.toBe(true);
  });

  it('awaitIdle resolves when the last in-flight turn reports done', async () => {
    // §3.9's "in-flight turns run to completion". Shutdown must wait for this, or a SIGTERM
    // kills every turn the pool was multiplexing.
    const h = harness();
    h.forked[0]!.ready();
    h.forked[1]!.ready();
    h.forked[0]!.load(2);
    const idle = h.pool.awaitIdle(5000);
    h.forked[0]!.load(1);
    h.forked[0]!.load(0);
    await expect(idle).resolves.toBe(true);
  });

  it('awaitIdle gives up at the deadline rather than hanging on a stuck turn', async () => {
    // The bound matters as much as the wait: without one a single stuck turn would hold the
    // supervisor open until systemd's TimeoutStopSec SIGKILLed it.
    const h = harness();
    h.forked[0]!.ready();
    h.forked[0]!.load(1);
    await expect(h.pool.awaitIdle(20)).resolves.toBe(false);
  });

  it('drains every OTHER worker when one channel is already dead', () => {
    // drainAll() is the first thing shutdown does, so a throw from a dead channel here would
    // abandon the drain of every later worker and leave them taking new turns while the
    // supervisor tears down.
    const h = harness();
    h.forked[0]!.ready();
    h.forked[1]!.ready();
    h.forked[0]!.sendThrows = true;
    expect(() => h.pool.drainAll()).not.toThrow();
    expect(h.forked[1]!.sent.filter((s) => s.msg.type === 'drain')).toHaveLength(1);
  });
});
