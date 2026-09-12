import { describe, it, expect } from 'vitest';
import { createServer, connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { maxHeaderSize } from 'node:http';
import { headerBlockEnd, sessionIdFromHead, readHead, MAX_HEAD_BYTES } from '../src/head.js';

async function socketPair(): Promise<[Socket, Socket, () => void]> {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address() as { port: number };
  const client = connect(port, '127.0.0.1');
  // 'connect' is one-shot: capture the promise in the SAME tick as connect(), or it can fire
  // while we are suspended on 'connection' and this await never settles.
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

describe('headerBlockEnd', () => {
  it('returns the index just past CRLFCRLF', () => {
    const buf = Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\nBODY');
    expect(headerBlockEnd(buf)).toBe(buf.indexOf('BODY'));
  });

  it('returns -1 while the block is incomplete, including a straddling terminator', () => {
    expect(headerBlockEnd(Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n'))).toBe(-1);
    expect(headerBlockEnd(Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r'))).toBe(-1);
  });
});

describe('sessionIdFromHead', () => {
  it('reads X-SH-Session-Id case-insensitively and trims', () => {
    const head = Buffer.from('POST /turn HTTP/1.1\r\nx-sh-SESSION-id:  sess-7 \r\n\r\n');
    expect(sessionIdFromHead(head)).toBe('sess-7');
  });

  it('is undefined when the header is absent or empty', () => {
    expect(
      sessionIdFromHead(Buffer.from('POST /turn HTTP/1.1\r\nHost: x\r\n\r\n')),
    ).toBeUndefined();
    expect(
      sessionIdFromHead(Buffer.from('POST /turn HTTP/1.1\r\nX-SH-Session-Id:\r\n\r\n')),
    ).toBeUndefined();
  });

  it('does not mistake a body line for a header', () => {
    // The body is not header space; a client could otherwise steer routing with its payload.
    const head = Buffer.from('POST /turn HTTP/1.1\r\nHost: x\r\n\r\nX-SH-Session-Id: spoofed\r\n');
    expect(sessionIdFromHead(head)).toBeUndefined();
  });
});

describe('readHead', () => {
  it('forwards EVERY consumed byte, including body bytes in the same packet', async () => {
    // The failure this pins: returning only up to headerBlockEnd loses the body bytes that
    // arrived with it. They are already out of the kernel buffer, and the fd carries no
    // JS-side buffer, so anything dropped here is gone — the worker would hang waiting on a
    // body that never arrives.
    const [server, client, cleanup] = await socketPair();
    const wire = 'POST /turn HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\n{}';
    client.write(wire);
    const head = await readHead(server);
    expect(head.complete).toBe(true);
    expect(head.outcome).toBe('complete');
    expect(head.bytes.toString('utf8')).toBe(wire);
    cleanup();
  });

  it('assembles a header block split across packets', async () => {
    const [server, client, cleanup] = await socketPair();
    client.write('POST /turn HTTP/1.1\r\nX-SH-Session-Id: sess-9\r');
    const pending = readHead(server);
    await new Promise((r) => setImmediate(r));
    client.write('\nHost: x\r\n\r\n');
    const head = await pending;
    expect(head.complete).toBe(true);
    expect(sessionIdFromHead(head.bytes)).toBe('sess-9');
    cleanup();
  });

  it('leaves the socket paused, so no byte is consumed after the decision', async () => {
    // Between the read and `child.send(msg, socket)` the supervisor must not swallow more
    // bytes: whatever it reads after this point has nowhere to go.
    const [server, client, cleanup] = await socketPair();
    client.write('POST /turn HTTP/1.1\r\nHost: x\r\n\r\n');
    await readHead(server);
    expect(server.isPaused()).toBe(true);
    cleanup();
  });

  it('gives up at the cap and still forwards what it read', async () => {
    const [server, client, cleanup] = await socketPair();
    client.write('POST /turn HTTP/1.1\r\n' + 'X-Pad: '.padEnd(400, 'y') + '\r\n');
    const head = await readHead(server, { maxBytes: 64 });
    expect(head.complete).toBe(false);
    expect(head.bytes.length).toBeGreaterThan(0);
    // WHY it stopped, not just that it did. A cap hit costs the connection its affinity, and
    // `complete: false` alone cannot be told apart from a peer that timed out or hung up -- so
    // on the sticky arm a truncating workload reads as a low hit rate with nothing in the data
    // distinguishing it from a genuine null result.
    expect(head.outcome).toBe('cap');
    // No 431 from here: the supervisor does not adjudicate HTTP, the worker's parser does.
    cleanup();
  });

  it('gives up on a silent client and forwards nothing', async () => {
    const [server, , cleanup] = await socketPair();
    const head = await readHead(server, { timeoutMs: 25 });
    expect(head).toEqual({ bytes: Buffer.alloc(0), complete: false, outcome: 'timeout' });
    cleanup();
  });

  it("caps at exactly Node's maxHeaderSize, which is what the comment claims", () => {
    // It was 8192 while the comment said it matched `maxHeaderSize`. The gap was a class of
    // requests the worker's parser would have served but the router structurally could not see
    // a session id in, so they routed with no affinity and nothing said so.
    expect(MAX_HEAD_BYTES).toBe(maxHeaderSize);
    expect(MAX_HEAD_BYTES).toBe(16384);
  });
});
