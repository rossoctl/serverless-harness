import type { Socket } from 'node:net';
import type { WorkerView } from './routing.js';

/**
 * One second. Long enough for a burst edge to clear at the turn durations E6 measured, short
 * enough that a driver's retry still lands inside the rung it belongs to.
 */
export const RETRY_AFTER_SECONDS = 1;

/**
 * True ⇒ no healthy worker is below the per-worker in-flight turn cap S (§3.8).
 *
 * Unhealthy workers are excluded rather than counted as empty: a restarting worker reports
 * inFlight 0, which would read as free capacity that does not exist. With no healthy worker
 * at all this returns true, so the caller answers with back-pressure instead of parking the
 * connection until a fork completes.
 */
export function isSaturated(workers: readonly WorkerView[], turnsPerWorker: number): boolean {
  return !workers.some((wv) => wv.healthy && wv.inFlight < turnsPerWorker);
}

const BODY = '{"error":"overloaded"}';

/**
 * How long a refused socket may linger after its FIN before it is destroyed.
 *
 * `refuse()` ends the socket and relies on the peer to close, and with `allowHalfOpen` false a
 * well-behaved peer's FIN destroys it within a round trip. But `refuse()` fires under exactly
 * the overload that makes peers misbehave: one that never closes left the fd open indefinitely,
 * held the server's connection count above zero, and made `once(server, 'close')` never
 * resolve -- so shutdown hung until systemd SIGKILLed the unit at `TimeoutStopSec=120`.
 *
 * Generous enough that a slow or lossy peer still reads its 429 and closes on its own terms,
 * short enough that the leak is bounded by rate x this window rather than unbounded.
 */
export const REFUSAL_LINGER_MS = 5_000;

/**
 * Refuse a connection with `429` + `Retry-After`, **before** hand-off (§3.5, #55).
 *
 * Written straight onto the socket because the supervisor's listener is a `net.Server`: it
 * has to be, since hand-off passes the socket itself. Admitting the connection and failing
 * inside a worker instead would turn clean back-pressure into a mid-turn error and would
 * corrupt E8's rungs by counting admitted-but-doomed turns.
 */
export function refuse(
  socket: Socket,
  opts: { retryAfterSeconds?: number; lingerMs?: number } = {},
): void {
  const retryAfter = opts.retryAfterSeconds ?? RETRY_AFTER_SECONDS;
  // Drain the readable side before ending it: a paused socket (no `'data'` listener) never
  // observes the peer's FIN, so without this it stays half-open and `server.close()` never
  // fires its `'close'` event. This runs after the admission decision, so it is not a §3.5
  // read — no byte here informs the refusal, and with no `'data'` listener the bytes are
  // discarded, not parsed.
  socket.resume();
  socket.end(
    `HTTP/1.1 429 Too Many Requests\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(BODY, 'utf8')}\r\n` +
      `Retry-After: ${retryAfter}\r\n` +
      `Connection: close\r\n` +
      `\r\n${BODY}`,
  );
  // Bound the half-open window (see REFUSAL_LINGER_MS). Kept here rather than at each call site
  // so the whole refusal -- drain, 429, and teardown -- lives in one place.
  const linger = setTimeout(() => socket.destroy(), opts.lingerMs ?? REFUSAL_LINGER_MS);
  // unref'd: a pending refusal must never be the reason the process stays alive. Cleared on
  // 'close' so a well-behaved peer's socket is released immediately instead of being retained
  // by the timer for the whole window -- which under a refusal storm is the difference between
  // holding rate x window sockets and holding none.
  linger.unref?.();
  socket.once('close', () => clearTimeout(linger));
}
