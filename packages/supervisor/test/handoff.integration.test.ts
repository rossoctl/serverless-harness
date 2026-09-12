import { describe, it, expect, afterEach, vi } from 'vitest';
import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.js';
import { startSupervisor, type Supervisor } from '../src/main.js';

const sseWorker = fileURLToPath(new URL('./fixtures/sse-worker.mjs', import.meta.url));

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PORT: '0', SH_ADMIN_PORT: '0', SH_TURNS_PER_WORKER: '8', ...extra } as NodeJS.ProcessEnv;
}

async function waitReady(sup: Supervisor, n: number): Promise<void> {
  await vi.waitFor(() => expect(sup.pool.views().filter((v) => v.healthy)).toHaveLength(n), {
    timeout: 5000,
  });
}

/** Descriptor count for this process; Linux-only, so the leak test skips elsewhere. */
async function openFdCount(): Promise<number> {
  try {
    return (await readdir('/proc/self/fd')).length;
  } catch {
    return Number.NaN; // macOS: the assertion below is vacuously true, CI on Linux enforces it
  }
}

/** Open a raw connection, write `request`, and collect until the server closes or `until` hits. */
async function speak(
  port: number,
  request: string,
  until?: (text: string) => boolean,
): Promise<{ socket: Socket; text: string }> {
  const socket = connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(request);
  const chunks: Buffer[] = [];
  const text = (): string => Buffer.concat(chunks).toString('utf8');
  await new Promise<void>((resolve, reject) => {
    const done = (): void => resolve();
    socket.on('data', (c: Buffer) => {
      chunks.push(c);
      if (until?.(text())) resolve();
    });
    socket.on('end', done);
    socket.on('error', reject);
  });
  return { socket, text: text() };
}

let sup: Supervisor | undefined;
afterEach(async () => {
  await sup?.close();
  sup = undefined;
});

describe('socket hand-off, end to end', () => {
  it('streams an SSE response through a handed-off socket', async () => {
    // THE load-bearing property of §3.2. If the supervisor were proxying bytes, this would
    // still pass — but its event loop would be on the data path and would become the ceiling
    // E8 measures. Streaming working here is what proves it is not.
    sup = await startSupervisor({
      config: readConfig(env({ SH_WORKERS: '1' })),
      workerEntry: sseWorker,
      log: () => {},
      // Tests must not wait out a real drain deadline in teardown.
      shutdownGraceMs: 500,
    });
    await waitReady(sup, 1);

    const { socket, text } = await speak(sup.port, 'GET /stream HTTP/1.1\r\nHost: x\r\n\r\n', (t) =>
      t.includes('data: done'),
    );
    expect(text).toContain('text/event-stream');
    for (const n of [1, 2, 3]) expect(text).toContain(`data: chunk-${n}`);
    socket.destroy();
  }, 20_000);

  it.skipIf(process.platform !== 'linux')(
    'leaves the supervisor holding no reference to a handed-off socket',
    async () => {
      // A supervisor that keeps the socket keeps the fd, and on a saturation ladder that is a
      // leak with a hard ceiling (ulimit) rather than a slow degradation.
      // Linux-only: openFdCount() reads /proc/self/fd, which does not exist on macOS. There
      // NaN - NaN < 5 is false, so this case would fail rather than skip without the guard.
      // Linux CI is where this property is actually enforced (the VM target is Linux).
      sup = await startSupervisor({
        config: readConfig(env({ SH_WORKERS: '1' })),
        workerEntry: sseWorker,
        log: () => {},
      });
      await waitReady(sup, 1);
      const before = await openFdCount();
      for (let i = 0; i < 20; i += 1) {
        const { socket, text } = await speak(
          sup.port,
          'GET /ping HTTP/1.1\r\nHost: x\r\n\r\n',
          (t) => t.includes('"pid"'),
        );
        // Assert it was SERVED, not refused. Without this the case measured only descriptors,
        // and `speak` resolves on 'end' -- which a 429 produces too. It therefore passed green
        // over twelve refusals while the monotonic-estimate defect wedged the pool at S=8: the
        // fd count is a valid measurement only if the connections it counts were handed off.
        expect(text, `connection ${i + 1}`).not.toContain('429');
        socket.destroy();
      }
      // Allow for a handful of transient descriptors; a leak shows up as ~20.
      expect((await openFdCount()) - before).toBeLessThan(5);
    },
    20_000,
  );

  it('serves 20 sequential non-turn connections at S=8 without refusing one', async () => {
    // The platform-independent half of the case below, which is Linux-only because it reads
    // /proc/self/fd. This is the arrangement that used to wedge: W=1, S=8, and 20 connections
    // carrying a request the worker serves but does not count as a turn. The estimate rose by
    // one per connection with nothing ever bringing it down, so connections 9-20 were all
    // refused before hand-off -- and no turn could then arrive to reconcile.
    sup = await startSupervisor({
      config: readConfig(env({ SH_WORKERS: '1' })),
      workerEntry: sseWorker,
      log: () => {},
      // Tests must not wait out a real drain deadline in teardown.
      shutdownGraceMs: 500,
    });
    await waitReady(sup, 1);
    for (let i = 1; i <= 20; i += 1) {
      const { socket, text } = await speak(sup.port, 'GET /ping HTTP/1.1\r\nHost: x\r\n\r\n', (t) =>
        t.includes('"pid"'),
      );
      expect(text, `connection ${i}`).toContain('"pid"');
      socket.destroy();
      await vi.waitFor(() => expect(sup!.pool.views()[0]!.inFlight).toBe(0));
    }
  }, 30_000);

  it('spreads connections across workers by least-in-flight', async () => {
    sup = await startSupervisor({
      config: readConfig(env({ SH_WORKERS: '2' })),
      workerEntry: sseWorker,
      log: () => {},
      // Tests must not wait out a real drain deadline in teardown.
      shutdownGraceMs: 500,
    });
    await waitReady(sup, 2);
    const pids = new Set<number>();
    for (let i = 0; i < 6; i += 1) {
      const { socket, text } = await speak(sup.port, 'GET /ping HTTP/1.1\r\nHost: x\r\n\r\n', (t) =>
        t.includes('"pid"'),
      );
      pids.add(JSON.parse(text.split('\r\n\r\n')[1]!).pid as number);
      socket.destroy();
    }
    expect(pids.size).toBe(2);
  }, 20_000);
});

describe('sticky routing is connection-scoped (§3.4, §7)', () => {
  it('routes by X-SH-Session-Id and pins the session to one worker', async () => {
    sup = await startSupervisor({
      config: readConfig(env({ SH_WORKERS: '2', SH_ROUTING_POLICY: 'stickyBySession' })),
      workerEntry: sseWorker,
      log: () => {},
      // Tests must not wait out a real drain deadline in teardown.
      shutdownGraceMs: 500,
    });
    await waitReady(sup, 2);
    const pidFor = async (sid: string): Promise<number> => {
      const { socket, text } = await speak(
        sup!.port,
        `GET /ping HTTP/1.1\r\nHost: x\r\nX-SH-Session-Id: ${sid}\r\n\r\n`,
        (t) => t.includes('"pid"'),
      );
      socket.destroy();
      return JSON.parse(text.split('\r\n\r\n')[1]!).pid as number;
    };
    const first = await pidFor('sess-a');
    expect(await pidFor('sess-a')).toBe(first);
    expect(await pidFor('sess-a')).toBe(first);
    // The head must have survived the hand-off intact, header and all.
    const { socket, text } = await speak(
      sup.port,
      'GET /ping HTTP/1.1\r\nHost: x\r\nX-SH-Session-Id: sess-a\r\n\r\n',
      (t) => t.includes('"pid"'),
    );
    expect(JSON.parse(text.split('\r\n\r\n')[1]!).sid).toBe('sess-a');
    socket.destroy();
  }, 20_000);

  it('counts a head that overruns the cap, and still routes the connection', async () => {
    // The cap costs this connection its affinity, so it must be visible in `/metrics` rather
    // than showing up only as a lower sticky hit rate.
    sup = await startSupervisor({
      config: readConfig(env({ SH_WORKERS: '1', SH_ROUTING_POLICY: 'stickyBySession' })),
      workerEntry: sseWorker,
      log: () => {},
      shutdownGraceMs: 500,
    });
    await waitReady(sup, 1);
    expect(sup.pool.counters.headTruncations).toBe(0);

    // A header block that overruns MAX_HEAD_BYTES (= Node's maxHeaderSize) BEFORE terminating.
    // The terminator is deliberately absent: `readHead` checks for CRLFCRLF before the cap, and
    // on loopback a 20 KB write can arrive as a single chunk, in which case a terminated block
    // resolves 'complete' in one pass and never reaches the cap at all.
    const socket = connect(sup.port, '127.0.0.1');
    await once(socket, 'connect');
    socket.on('error', () => {});
    socket.write(`GET /ping HTTP/1.1\r\nHost: x\r\nX-Pad: ${'y'.repeat(20_000)}\r\n`);
    await vi.waitFor(() => expect(sup!.pool.counters.headTruncations).toBe(1));
    socket.destroy();
    // Still handed off, not dropped: the supervisor does not adjudicate HTTP.
    expect(sup.pool.counters.handoffFailures).toBe(0);
  }, 20_000);

  it('does NOT re-route a second request on the same connection', async () => {
    // §7 requires this pinned by test. Affinity is decided ONCE per connection, keyed by the
    // first request; a second session id on the same socket is neither seen nor re-routable,
    // because the supervisor no longer holds the socket. Documented behaviour, not a bug —
    // but only if a test says so out loud.
    sup = await startSupervisor({
      config: readConfig(env({ SH_WORKERS: '2', SH_ROUTING_POLICY: 'stickyBySession' })),
      workerEntry: sseWorker,
      log: () => {},
      // Tests must not wait out a real drain deadline in teardown.
      shutdownGraceMs: 500,
    });
    await waitReady(sup, 2);

    const socket = connect(sup.port, '127.0.0.1');
    await once(socket, 'connect');
    const chunks: Buffer[] = [];
    socket.on('data', (c: Buffer) => chunks.push(c));
    const bodies = async (n: number): Promise<Array<{ pid: number; sid: string | null }>> => {
      await vi.waitFor(() =>
        expect(
          Buffer.concat(chunks)
            .toString()
            .match(/\{"pid"/g)?.length ?? 0,
        ).toBe(n),
      );
      return [
        ...Buffer.concat(chunks)
          .toString()
          .matchAll(/(\{"pid".*?\})/g),
      ].map((m) => JSON.parse(m[1]!));
    };

    socket.write('GET /ping HTTP/1.1\r\nHost: x\r\nX-SH-Session-Id: sess-a\r\n\r\n');
    const [one] = await bodies(1);
    // A DIFFERENT session, reusing the connection: it lands on the same worker regardless.
    socket.write('GET /ping HTTP/1.1\r\nHost: x\r\nX-SH-Session-Id: sess-b\r\n\r\n');
    const [, two] = await bodies(2);
    expect(two!.pid).toBe(one!.pid);
    expect(two!.sid).toBe('sess-b'); // the worker sees it; the router never did
    socket.destroy();
  }, 20_000);
});

describe('admission control end to end (§3.5)', () => {
  it('answers 429 with Retry-After once every worker is at S', async () => {
    sup = await startSupervisor({
      config: readConfig(env({ SH_WORKERS: '1', SH_TURNS_PER_WORKER: '1' })),
      workerEntry: sseWorker,
      log: () => {},
      // Tests must not wait out a real drain deadline in teardown.
      shutdownGraceMs: 500,
    });
    await waitReady(sup, 1);

    // Occupy the single slot with a stream that is deliberately not finished.
    const held = connect(sup.port, '127.0.0.1');
    await once(held, 'connect');
    held.write('GET /stream HTTP/1.1\r\nHost: x\r\n\r\n');
    await once(held, 'data');
    await vi.waitFor(() => expect(sup!.pool.views()[0]!.inFlight).toBeGreaterThan(0));

    const { socket, text } = await speak(sup.port, 'GET /ping HTTP/1.1\r\nHost: x\r\n\r\n');
    expect(text).toContain('429 Too Many Requests');
    expect(text.toLowerCase()).toContain('retry-after:');
    socket.destroy();
    held.destroy();
  }, 20_000);
});
