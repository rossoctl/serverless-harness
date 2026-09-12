import { describe, it, expect } from 'vitest';
import { createServer, connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { isSaturated, refuse, RETRY_AFTER_SECONDS } from '../src/admission.js';
import type { WorkerView } from '../src/routing.js';

const w = (id: number, inFlight: number, healthy = true): WorkerView => ({ id, inFlight, healthy });

describe('isSaturated', () => {
  it('is false while any healthy worker is below the cap', () => {
    expect(isSaturated([w(0, 4), w(1, 3)], 4)).toBe(false);
  });

  it('is true when every healthy worker is at or above the cap', () => {
    expect(isSaturated([w(0, 4), w(1, 4)], 4)).toBe(true);
    // Above the cap is reachable: over-admission on a kept-alive socket (§3.9).
    expect(isSaturated([w(0, 5), w(1, 4)], 4)).toBe(true);
  });

  it('ignores unhealthy workers, so a restarting worker cannot mask saturation', () => {
    // Its inFlight is 0, which would otherwise read as free capacity that does not exist.
    expect(isSaturated([w(0, 4), w(1, 0, false)], 4)).toBe(true);
  });

  it('is true with no healthy workers at all', () => {
    // During a full restart the honest answer is back-pressure, not a hung connection.
    expect(isSaturated([w(0, 0, false)], 4)).toBe(true);
    expect(isSaturated([], 4)).toBe(true);
  });
});

describe('refuse', () => {
  async function refusalWire(opts?: { retryAfterSeconds?: number }): Promise<string> {
    const listener = createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const { port } = listener.address() as { port: number };
    const client = connect(port, '127.0.0.1');
    // Eager capture: 'connect' can fire while we are awaiting 'connection', and a `once()`
    // registered after the fact would never settle.
    const clientConnected = once(client, 'connect');
    const [server] = (await once(listener, 'connection')) as [Socket];
    await clientConnected;
    listener.close();

    const chunks: Buffer[] = [];
    client.on('data', (c: Buffer) => chunks.push(c));
    refuse(server, opts);
    await once(client, 'end');
    client.destroy();
    return Buffer.concat(chunks).toString('utf8');
  }

  it('writes a well-formed 429 with Retry-After and closes the connection', async () => {
    const wire = await refusalWire();
    expect(wire.split('\r\n')[0]).toBe('HTTP/1.1 429 Too Many Requests');
    expect(wire.toLowerCase()).toContain(`retry-after: ${RETRY_AFTER_SECONDS}`);
    expect(wire.toLowerCase()).toContain('connection: close');
    expect(wire).toMatch(/\r\n\r\n\{.*\}$/s);
  });

  it('declares a Content-Length that matches the body byte length', async () => {
    // A wrong length is the classic hand-rolled-HTTP bug: the client waits for bytes that
    // never come, and a load driver reports it as a TIMEOUT — which on an E8 rung looks
    // exactly like the knee we are hunting.
    const wire = await refusalWire();
    const [head, body] = wire.split('\r\n\r\n');
    const declared = Number(/content-length: (\d+)/i.exec(head!)![1]);
    expect(declared).toBe(Buffer.byteLength(body!, 'utf8'));
  });

  it('has a JSON body a driver can classify', async () => {
    const wire = await refusalWire();
    const body = wire.split('\r\n\r\n')[1]!;
    expect(JSON.parse(body)).toEqual({ error: 'overloaded' });
  });

  it('honours an overridden Retry-After', async () => {
    const wire = await refusalWire({ retryAfterSeconds: 7 });
    expect(wire.toLowerCase()).toContain('retry-after: 7');
  });

  it('does not keep the server open when the refused peer never closes', async () => {
    // refuse() sends FIN and relies on the peer to close -- but it fires under exactly the
    // overload that makes peers misbehave. A peer that never closes left the fd open
    // indefinitely, held the server's connection count above zero, and made
    // `once(server, 'close')` never resolve, so shutdown hung until systemd SIGKILLed the unit
    // at TimeoutStopSec=120.
    const listener = createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const { port } = listener.address() as { port: number };
    const client = connect(port, '127.0.0.1');
    const clientConnected = once(client, 'connect');
    const [server] = (await once(listener, 'connection')) as [Socket];
    await clientConnected;

    // Captured before close() can fire it.
    const listenerClosed = once(listener, 'close');
    refuse(server, { lingerMs: 50 });
    // The client deliberately never reads and never closes: the misbehaving peer.
    listener.close();
    await listenerClosed;
    expect(server.destroyed).toBe(true);
    client.destroy();
  }, 5000);

  it('clears the linger timer when a well-behaved peer closes first', async () => {
    // The timer holds a reference to the socket, so under a refusal storm an uncleared one
    // would retain every refused socket for the whole linger window.
    const listener = createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const { port } = listener.address() as { port: number };
    const client = connect(port, '127.0.0.1');
    const clientConnected = once(client, 'connect');
    const [server] = (await once(listener, 'connection')) as [Socket];
    await clientConnected;
    listener.close();

    // In production `main.ts`'s connection callback attaches this to every accepted socket;
    // without it the RST below is an unhandled 'error' that kills the process. Attached here
    // because this test drives `refuse()` directly rather than through the server.
    server.on('error', () => {});
    // A plain listener rather than `events.once()`: that helper attaches its own 'error' handler
    // and REJECTS the promise, so the RST below would surface as a failure rather than being the
    // ordinary peer departure it is.
    const serverClosed = new Promise<void>((resolve) => server.once('close', () => resolve()));
    refuse(server, { lingerMs: 60_000 });
    // A hard destroy: the 429 is still unread, so the peer's stack answers with RST.
    client.destroy();
    // Destroyed by the peer's departure, long before a 60s linger could have done it.
    await serverClosed;
    expect(server.destroyed).toBe(true);
  }, 5000);
});
