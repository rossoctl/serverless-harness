import { maxHeaderSize } from 'node:http';
import type { Socket } from 'node:net';

/**
 * Node's own `maxHeaderSize`, so this is genuinely not a second, stricter limit -- and follows
 * `--max-http-header-size` if an operator moves it.
 *
 * It was hard-coded 8192 while this comment claimed to match `maxHeaderSize` (16384). The gap
 * was a class of requests the worker's parser would have accepted and served, but in which the
 * router structurally could not see a session id: the head resolved `complete: false`, so no id
 * was extracted and the connection routed with NO affinity, silently. On the sticky arm that
 * reads as a low hit rate with nothing in the data separating it from a genuine null result.
 *
 * Tracking Node's value keeps the router's visibility window exactly as wide as what the worker
 * will accept. Narrower loses affinity for valid requests; wider would only read bytes the
 * parser is going to reject anyway. Cap hits are counted (`head_truncations` on /metrics), so
 * the remaining truncation class -- headers a worker would 431 regardless -- is visible instead
 * of silent.
 */
export const MAX_HEAD_BYTES = maxHeaderSize;

const TERMINATOR = Buffer.from('\r\n\r\n');

/** Index just past the terminating CRLFCRLF, or -1 if the header block is incomplete. */
export function headerBlockEnd(buf: Buffer): number {
  const at = buf.indexOf(TERMINATOR);
  return at === -1 ? -1 : at + TERMINATOR.length;
}

/**
 * `X-SH-Session-Id` from the header block only. Scanning past the terminator would let a
 * client steer routing from its request body.
 */
export function sessionIdFromHead(head: Buffer): string | undefined {
  const end = headerBlockEnd(head);
  const block = end === -1 ? head : head.subarray(0, end);
  for (const line of block.toString('latin1').split('\r\n').slice(1)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== 'x-sh-session-id') continue;
    const value = line.slice(colon + 1).trim();
    return value === '' ? undefined : value;
  }
  return undefined;
}

/** Why `readHead` stopped reading. */
export type HeadOutcome = 'complete' | 'cap' | 'timeout' | 'closed';

export interface HeadRead {
  /** EVERY byte consumed from the socket: header block plus any body bytes that rode along. */
  readonly bytes: Buffer;
  /** False ⇒ cap or timeout hit first. Route blind; the worker's parser rules on the request. */
  readonly complete: boolean;
  /**
   * WHY it stopped. `complete` alone cannot tell a header block larger than the cap -- which
   * costs the connection its affinity, and is a property of the WORKLOAD -- from a peer that
   * timed out or hung up, which is a property of the client. Only the first is a measurement
   * effect on E8's sticky arm, so only the first is counted.
   */
  readonly outcome: HeadOutcome;
}

/**
 * Read just enough to route a sticky connection, then stop.
 *
 * Two invariants, both load-bearing because the socket travels onward as a file descriptor:
 *  1. every byte consumed here is returned, so it can be replayed into the worker's stream;
 *  2. the socket is paused on resolve, so nothing further is consumed before hand-off.
 */
export function readHead(
  socket: Socket,
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<HeadRead> {
  const maxBytes = opts.maxBytes ?? MAX_HEAD_BYTES;
  const timeoutMs = opts.timeoutMs ?? 2000;

  return new Promise<HeadRead>((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (outcome: HeadOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onEnd);
      // Paused before the fd is handed over: invariant 2.
      socket.pause();
      resolve({
        bytes: Buffer.concat(chunks),
        complete: outcome === 'complete',
        outcome,
      });
    };

    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      total += chunk.length;
      if (headerBlockEnd(Buffer.concat(chunks)) !== -1) {
        finish('complete');
        return;
      }
      // Over the cap we stop reading but keep what we have: the bytes are already out of the
      // kernel buffer, so discarding them would corrupt the request the worker sees.
      if (total >= maxBytes) finish('cap');
    };
    const onEnd = (): void => finish('closed');

    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    timer.unref?.();
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onEnd);
    // Required, not defensive: main.ts's server is created with `pauseOnConnect: true`, so
    // attaching the 'data' listener above does not itself start the flow. Without this resume(),
    // no byte ever arrives, so the setTimeout above (2s default) is what actually fires: finish()
    // resolves incomplete, sessionId stays undefined, and the connection quietly routes without
    // its session affinity instead of failing loudly.
    socket.resume();
  });
}
