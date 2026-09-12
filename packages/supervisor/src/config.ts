import { cpus } from 'node:os';
import { policyFromName, type RoutingPolicy } from './routing.js';

export interface SupervisorConfig {
  readonly port: number;
  readonly workers: number;
  /** S — the per-worker soft cap on in-flight TURNS, not sessions (§3.8, §5.1). */
  readonly turnsPerWorker: number;
  readonly policy: RoutingPolicy;
  readonly restartBackoffMs: number;
  /** Loopback-only /metrics listener (§5.2, Task 11) — a separate port from the data path. */
  readonly adminPort: number;
}

function readInt(
  env: NodeJS.ProcessEnv,
  name: string,
  /** `undefined` ⇒ the variable is REQUIRED and has no legal default (GC7). */
  fallback: number | undefined,
  bounds: { min: number; max?: number },
): number {
  const raw = env[name]?.trim();
  if (!raw) {
    // Expressing "no default" as `undefined` rather than a number means no reader has to work
    // out whether the value in that slot is a legal one for the variable. `SH_TURNS_PER_WORKER`
    // used to pass 0 here, which read as though 0 were a legal S -- the opposite of what the
    // blank check in readConfig() says. That check fires first, so this branch is unreachable
    // for it; it is a real net for anything else declared required later.
    if (fallback === undefined) throw new Error(`${name} is required and has no default`);
    return fallback;
  }
  const n = Number(raw);
  const max = bounds.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isInteger(n) || n < bounds.min || n > max) {
    throw new Error(`${name}='${raw}' must be an integer in [${bounds.min}, ${max}]`);
  }
  return n;
}

export function readConfig(env: NodeJS.ProcessEnv): SupervisorConfig {
  const rawTurns = env.SH_TURNS_PER_WORKER?.trim();
  if (!rawTurns) {
    // No default on purpose (§3.8): every plausible one either hides the density this slice
    // exists to find or invites the thrash E8 is meant to locate — and unlike the other
    // knobs, its right value is an OUTPUT of E8, not a guess.
    throw new Error(
      'SH_TURNS_PER_WORKER is required and has no default: it is the per-worker cap on ' +
        'in-flight turns (S), and its right value is an output of E8, not a guess',
    );
  }
  const port = readInt(env, 'PORT', 8080, { min: 0, max: 65535 });
  const adminPort = readInt(env, 'SH_ADMIN_PORT', 8081, { min: 0, max: 65535 });
  if (adminPort !== 0 && adminPort === port) {
    // Two listeners on one port is an EADDRINUSE at boot in the best case; 0 is exempt
    // because the kernel hands out a distinct ephemeral port each time it is asked.
    throw new Error(`SH_ADMIN_PORT='${adminPort}' must differ from PORT='${port}'`);
  }
  return {
    port,
    workers: readInt(env, 'SH_WORKERS', cpus().length, { min: 1 }),
    turnsPerWorker: readInt(env, 'SH_TURNS_PER_WORKER', undefined, { min: 1 }),
    policy: policyFromName(env.SH_ROUTING_POLICY),
    restartBackoffMs: readInt(env, 'SH_WORKER_RESTART_BACKOFF_MS', 250, { min: 0 }),
    adminPort,
  };
}
