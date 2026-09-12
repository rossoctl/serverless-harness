import { describe, it, expect, vi } from 'vitest';
import { createServer as createNetServer, connect, type Socket } from 'node:net';
import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  isTurnRequest,
  TurnCounter,
  createWorkerRuntime,
  parseRole,
  startStatsReporter,
  type WorkerToSupervisor,
} from '../src/worker.js';

/** A connected loopback socket pair. Returns [serverSide, clientSide, cleanup]. */
async function socketPair(): Promise<[Socket, Socket, () => void]> {
  const listener = createNetServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address() as { port: number };
  const client = connect(port, '127.0.0.1');
  // Captured before the first await: 'connect' is one-shot and can fire while we are
  // suspended waiting on the listener's 'connection' event, so a once() registered after
  // the fact would wait for an event that already happened and never settle.
  const connected = once(client, 'connect');
  const [server] = (await once(listener, 'connection')) as [Socket];
  await connected;
  listener.close();
  return [
    server,
    client,
    () => {
      client.destroy();
      server.destroy();
    },
  ];
}

describe('isTurnRequest', () => {
  it('accepts both spellings server.ts:641 matches', () => {
    expect(isTurnRequest('POST', '/turn')).toBe(true);
    expect(isTurnRequest('POST', '/v1/turn')).toBe(true);
  });

  it('is exact-equality, mirroring server.ts (a query string is NOT a turn)', () => {
    // server.ts:641 compares the raw req.url for equality, so '/turn?sid=x' 404s there.
    // If this ever diverges the worker's in-flight count stops matching what it serves.
    expect(isTurnRequest('POST', '/turn?sid=abc')).toBe(false);
    expect(isTurnRequest('POST', '/turn/')).toBe(false);
    expect(isTurnRequest('GET', '/turn')).toBe(false);
    expect(isTurnRequest('POST', '/health')).toBe(false);
    expect(isTurnRequest(undefined, undefined)).toBe(false);
  });
});

describe('TurnCounter', () => {
  it('reports absolute in-flight on every change', () => {
    const seen: number[] = [];
    const c = new TurnCounter((n) => seen.push(n));
    const a = c.start();
    const b = c.start();
    expect(c.inFlight).toBe(2);
    a();
    b();
    expect(seen).toEqual([1, 2, 1, 0]);
  });

  it("end is idempotent — a double 'close' must not drift the count negative", () => {
    // res emits 'close' once, but a defensive second call from an abort path would
    // permanently bias the supervisor's estimate low ⇒ silent over-admission (§3.9).
    const seen: number[] = [];
    const c = new TurnCounter((n) => seen.push(n));
    const end = c.start();
    end();
    end();
    end();
    expect(c.inFlight).toBe(0);
    expect(seen).toEqual([1, 0]);
  });
});

describe('createWorkerRuntime', () => {
  it('announces ready with its pid once, and never binds a port', () => {
    const send = vi.fn<(msg: WorkerToSupervisor) => void>();
    const rt = createWorkerRuntime({ send, requestHandler: () => {} });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: 'ready', pid: process.pid });
    // listen() is never called: the server exists only to own an HTTP parser per socket.
    expect(rt.server.listening).toBe(false);
  });

  it('serves a full turn on a handed-off socket and reports load 1 then 0', async () => {
    const send = vi.fn<(msg: WorkerToSupervisor) => void>();
    let seen: { method?: string; url?: string; body: string } | undefined;
    const rt = createWorkerRuntime({
      send,
      requestHandler: (req: IncomingMessage, res: ServerResponse) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          seen = {
            method: req.method,
            url: req.url,
            body: Buffer.concat(chunks).toString('utf8'),
          };
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
        });
      },
    });

    const [server, client, cleanup] = await socketPair();
    const body = '{"sessionId":"s1","prompt":"hi"}';
    const req =
      `POST /turn HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${body.length}\r\n\r\n${body}`;

    rt.accept(server);
    client.write(req);

    const received: Buffer[] = [];
    client.on('data', (c: Buffer) => received.push(c));
    await vi.waitFor(() => expect(Buffer.concat(received).toString()).toContain('{"ok":true}'));

    expect(seen).toEqual({ method: 'POST', url: '/turn', body });
    const loads = send.mock.calls.map(([m]) => m).filter((m) => m.type === 'load');
    expect(loads).toEqual([
      { type: 'load', inFlight: 1 },
      { type: 'load', inFlight: 0 },
    ]);
    cleanup();
  });

  it('unshifts pre-read head bytes so the worker parser sees an intact request', async () => {
    // THE load-bearing test of the head protocol. A file descriptor carries no JS-side
    // buffer, so bytes the supervisor consumed are gone; if they are not unshifted HERE
    // the worker's parser sees a request that starts mid-header and hangs or 400s.
    const send = vi.fn<(msg: WorkerToSupervisor) => void>();
    let seen: { url?: string; sid?: string } | undefined;
    const rt = createWorkerRuntime({
      send,
      requestHandler: (req: IncomingMessage, res: ServerResponse) => {
        seen = { url: req.url, sid: req.headers['x-sh-session-id'] as string | undefined };
        res.writeHead(204).end();
      },
    });

    const [server, client, cleanup] = await socketPair();
    const head = Buffer.from(
      'POST /turn HTTP/1.1\r\nHost: x\r\nX-SH-Session-Id: sess-42\r\nContent-Length: 2\r\n\r\n',
      'utf8',
    );
    // The supervisor consumed the whole header block; only the body is still on the wire.
    rt.accept(server, head);
    client.write('{}');

    await vi.waitFor(() => expect(seen).toBeDefined());
    expect(seen).toEqual({ url: '/turn', sid: 'sess-42' });
    cleanup();
  });

  it('a non-turn request on a handed-off socket is served but not counted', async () => {
    const send = vi.fn<(msg: WorkerToSupervisor) => void>();
    const rt = createWorkerRuntime({
      send,
      requestHandler: (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200).end('ok');
      },
    });
    const [server, client, cleanup] = await socketPair();
    rt.accept(server);
    client.write('GET /health HTTP/1.1\r\nHost: x\r\n\r\n');
    const received: Buffer[] = [];
    client.on('data', (c: Buffer) => received.push(c));
    await vi.waitFor(() => expect(Buffer.concat(received).toString()).toContain('200'));
    expect(send.mock.calls.map(([m]) => m).filter((m) => m.type === 'load')).toEqual([]);
    cleanup();
  });

  it('reports load when a handed-off connection CLOSES, so non-turn traffic reconciles', async () => {
    // The supervisor credits its estimate +1 for every connection it hands off, but `load` is
    // only ever sent from the turn counter -- and a non-turn request never touches it. Without
    // a close report the estimate rose by one PERMANENTLY per non-turn connection, so after S
    // of them the pool refused everything BEFORE hand-off, no turn could arrive to reconcile,
    // and it stayed wedged in 429s until a worker crashed.
    const send = vi.fn<(msg: WorkerToSupervisor) => void>();
    const loads = (): WorkerToSupervisor[] =>
      send.mock.calls.map(([m]) => m).filter((m) => m.type === 'load');
    const rt = createWorkerRuntime({
      send,
      requestHandler: (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200).end('ok');
      },
    });
    const [server, client, cleanup] = await socketPair();
    rt.accept(server);
    client.write('GET /health HTTP/1.1\r\nHost: x\r\n\r\n');
    const received: Buffer[] = [];
    client.on('data', (c: Buffer) => received.push(c));
    await vi.waitFor(() => expect(Buffer.concat(received).toString()).toContain('200'));
    // Still not a turn: §3.5 caps TURNS, and "served but not counted" stays correct.
    expect(loads()).toEqual([]);

    client.destroy();
    // ...but the connection ending IS a reconciliation point.
    await vi.waitFor(() => expect(loads()).toEqual([{ type: 'load', inFlight: 0 }]));
    cleanup();
  });

  it('reports the ABSOLUTE in-flight count on close, never a decrement', async () => {
    // A connection closing while a turn is still running on ANOTHER socket must report the
    // truth. A decrement would erase turns the worker is really executing and bias the
    // supervisor's estimate low -- §3.9's dangerous direction, i.e. silent over-admission.
    const send = vi.fn<(msg: WorkerToSupervisor) => void>();
    const loads = (): WorkerToSupervisor[] =>
      send.mock.calls.map(([m]) => m).filter((m) => m.type === 'load');
    const rt = createWorkerRuntime({
      send,
      requestHandler: (req: IncomingMessage, res: ServerResponse) => {
        // A turn that never answers, so it stays in flight for the whole test.
        if (req.url === '/turn') return;
        res.writeHead(200).end('ok');
      },
    });

    const [turnServer, turnClient, cleanupTurn] = await socketPair();
    rt.accept(turnServer);
    turnClient.write('POST /turn HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n');
    await vi.waitFor(() => expect(loads()).toEqual([{ type: 'load', inFlight: 1 }]));

    const [probeServer, probeClient, cleanupProbe] = await socketPair();
    rt.accept(probeServer);
    probeClient.write('GET /health HTTP/1.1\r\nHost: x\r\n\r\n');
    const received: Buffer[] = [];
    probeClient.on('data', (c: Buffer) => received.push(c));
    await vi.waitFor(() => expect(Buffer.concat(received).toString()).toContain('200'));

    probeClient.destroy();
    await vi.waitFor(() =>
      expect(loads()).toEqual([
        { type: 'load', inFlight: 1 },
        { type: 'load', inFlight: 1 }, // the turn on the OTHER socket survives the report
      ]),
    );
    cleanupProbe();
    cleanupTurn();
  });

  it('ignores a conn that arrives with NO handle instead of dying', () => {
    // Defence against a handle-less `conn`. Node delivers a QUEUED handle-send with no handle
    // when the descriptor was already consumed elsewhere (measured: send #3 in a tick returns
    // false, is delivered, and if the socket was meanwhile sent to another child it arrives
    // with `hasHandle: false`). `server.emit('connection', undefined)` then throws
    // `TypeError: Cannot convert undefined or null to object` inside `process.on('message')`,
    // uncaught -- so the worker dies, taking every turn it was multiplexing with it. A
    // supervisor bug must degrade one connection, not the process.
    const send = vi.fn<(msg: WorkerToSupervisor) => void>();
    const rt = createWorkerRuntime({ send, requestHandler: () => {} });
    expect(() => rt.accept(undefined as unknown as Socket)).not.toThrow();
  });

  it('drain announces draining exactly once and is idempotent', () => {
    const send = vi.fn<(msg: WorkerToSupervisor) => void>();
    const rt = createWorkerRuntime({ send, requestHandler: () => {} });
    rt.drain();
    rt.drain();
    expect(send.mock.calls.map(([m]) => m).filter((m) => m.type === 'draining')).toEqual([
      { type: 'draining' },
    ]);
  });
});

describe('startStatsReporter', () => {
  it('reports stats on an interval, and load stays exactly §3.9 s three rows', async () => {
    const sent: unknown[] = [];
    const stop = startStatsReporter({
      send: (m) => sent.push(m),
      intervalMs: 5,
      lag: () => 3.5,
      rss: () => 1_000,
    });
    await new Promise((r) => setTimeout(r, 20));
    stop();
    const stats = sent.filter((m) => (m as { type: string }).type === 'stats');
    expect(stats.length).toBeGreaterThan(0);
    expect(stats[0]).toMatchObject({ type: 'stats', loopLagP99Ms: 3.5, rssBytes: 1_000 });
    // The hot message is untouched: no percentile is computed per turn edge.
    expect(sent.some((m) => (m as { type: string }).type === 'load')).toBe(false);
  });

  it('stops reporting after stop(), so a draining worker goes quiet', async () => {
    const sent: unknown[] = [];
    const stop = startStatsReporter({
      send: (m) => sent.push(m),
      intervalMs: 5,
      lag: () => 1,
      rss: () => 1,
    });
    stop();
    const n = sent.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.length).toBe(n);
  });
});

describe('parseRole', () => {
  it("parses '--role=leaf'", () => {
    expect(parseRole(['--role=leaf'])).toBe('leaf');
  });

  it("parses '--role', 'leaf' as two argv entries", () => {
    expect(parseRole(['--role', 'leaf'])).toBe('leaf');
  });

  it("defaults to 'turn' when no --role flag is present", () => {
    expect(parseRole([])).toBe('turn');
  });

  it("returns '' when '--role' has no following value", () => {
    expect(parseRole(['--role'])).toBe('');
  });
});
