/** What the supervisor believes about one worker at decision time. */
export interface WorkerView {
  readonly id: number;
  /**
   * The supervisor's ESTIMATE, not ground truth: incremented optimistically on hand-off and
   * reconciled whenever the worker sends `load` (§3.9). Lag is bounded by one IPC round trip.
   */
  readonly inFlight: number;
  readonly healthy: boolean;
}

/** All a policy is allowed to know about the connection it is routing. */
export interface ConnectionFacts {
  readonly sessionId?: string;
}

export interface RoutingPolicy {
  readonly name: 'leastInFlight' | 'stickyBySession';
  /** True ⇒ the supervisor must pre-read the request head before it can call `pick`. */
  readonly needsHead: boolean;
  /**
   * Called exactly ONCE per connection, before hand-off. There is deliberately no
   * per-request entry point: a keep-alive socket belongs to the worker that received it, and
   * a second session id arriving on it is neither seen nor re-routable (§3.4, §7).
   */
  pick(workers: readonly WorkerView[], facts: ConnectionFacts): number | undefined;
}

/** Fewest in-flight turns wins; ties go to the lowest id so E8 replays are deterministic. */
export function pickLeastLoaded(workers: readonly WorkerView[]): number | undefined {
  let best: WorkerView | undefined;
  for (const wv of workers) {
    // A restarting worker has inFlight 0, which would make it the most attractive target
    // exactly when it cannot serve. Health gates the comparison; it is not a tiebreak.
    if (!wv.healthy) continue;
    if (best === undefined || wv.inFlight < best.inFlight) best = wv;
  }
  return best?.id;
}

/**
 * Default. Deliberately mirrors `orderByLoad` one tier up (`harness/src/select-sandbox.ts:16`)
 * so the two tiers are not separately-tuned mysteries when E9 compares them.
 */
export const leastInFlight: RoutingPolicy = {
  name: 'leastInFlight',
  // No head ⇒ the supervisor never reads a request byte on the default path (§3.2).
  needsHead: false,
  pick: (workers) => pickLeastLoaded(workers),
};

/**
 * Cap on one policy's affinity table.
 *
 * A MEMORY BOUND against an attacker-supplied key: the table is keyed by `X-SH-Session-Id`,
 * which the client chooses, on a listener bound `0.0.0.0`. Unbounded, any client can grow it
 * without limit with a loop of fresh ids. Evicting a pin is correct behaviour rather than a
 * compromise -- affinity is connection-scoped (§3.4), so an evicted session simply routes again
 * by least-in-flight, exactly as its first connection did.
 */
export const MAX_SESSION_PINS = 10_000;

/**
 * Sweep variant (§3.4): pin a session to a worker so its in-process state is reused. Costs a
 * pre-read of the header block, which is why it is not the default.
 *
 * Each call returns a policy with its OWN affinity table: sharing one would leak pins across
 * E8/E9 arms and quietly change what a rung measures.
 */
export function stickyBySession(opts: { maxPins?: number } = {}): RoutingPolicy {
  const maxPins = opts.maxPins ?? MAX_SESSION_PINS;
  const pins = new Map<string, number>();

  /** Insert-or-refresh, then evict oldest-first. `Map` iterates in insertion order. */
  const remember = (sid: string, id: number): void => {
    // Delete before set so a refresh moves the key to the most-recently-used end. Without this
    // an id flood would evict a continuously-used session in insertion order, turning the
    // memory bound into a lever for denying affinity to real traffic.
    pins.delete(sid);
    pins.set(sid, id);
    while (pins.size > maxPins) {
      const oldest = pins.keys().next();
      if (oldest.done) break;
      pins.delete(oldest.value);
    }
  };

  return {
    name: 'stickyBySession',
    needsHead: true,
    pick(workers, facts) {
      const sid = facts.sessionId;
      if (sid === undefined) return pickLeastLoaded(workers);
      const pinned = pins.get(sid);
      if (pinned !== undefined && workers.some((wv) => wv.id === pinned && wv.healthy)) {
        remember(sid, pinned);
        return pinned;
      }
      const chosen = pickLeastLoaded(workers);
      // Re-pin rather than retry the dead worker; otherwise a crash strands every session
      // that was affine to it (§6).
      if (chosen !== undefined) remember(sid, chosen);
      return chosen;
    },
  };
}

export function policyFromName(name: string | undefined): RoutingPolicy {
  const raw = name?.trim();
  if (!raw || raw === 'leastInFlight') return leastInFlight;
  if (raw === 'stickyBySession') return stickyBySession();
  throw new Error(`SH_ROUTING_POLICY='${raw}' is not one of leastInFlight|stickyBySession`);
}
