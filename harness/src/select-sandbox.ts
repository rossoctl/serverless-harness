import { credentials } from '@grpc/grpc-js';
import {
  listPoolPods,
  resolveSandboxConfig,
  GrpcRelayTransport,
  SandboxExecClient,
  type RunKubectl,
  type K8sSandboxConfig,
  type SandboxTransport,
  type ExecClientLike,
} from '@sh/k8s-sandbox';
import { RedisLeaseStore, type LeaseStore } from './sandbox-lease.js';
import { RedisRecordStore, type RecordStore, type SandboxRecord } from './pool-records.js';

/** Pure: pods ordered ascending by active load (stable — ties keep input order). */
export function orderByLoad(loads: { pod: string; active: number }[]): string[] {
  return loads
    .map((l, i) => ({ ...l, i }))
    .sort((a, b) => a.active - b.active || a.i - b.i)
    .map((l) => l.pod);
}

/** Which sandbox inventories `selectPoolSandbox` consults. */
export type DiscoverySource = 'pods' | 'records' | 'both';

/**
 * Resolve `SH_SANDBOX_DISCOVERY`. Unset ⇒ `both`, which is byte-for-byte today's behaviour
 * (pods always listed; records only read when the remote flag is on).
 *  - `pods`    — kubectl listing only; mirrored grpc records are ignored even with the flag on.
 *  - `records` — mirrored grpc records only; never shells out to kubectl. This is what lets a
 *                bare VM (no cluster, no kubeconfig) reach a relay-fronted sandbox.
 *  - `both`    — the historical default.
 */
export function resolveDiscoverySource(
  env: NodeJS.ProcessEnv,
  remoteSandbox: boolean,
): DiscoverySource {
  const raw = env.SH_SANDBOX_DISCOVERY?.trim();
  if (!raw) return 'both';
  if (raw !== 'pods' && raw !== 'records' && raw !== 'both') {
    throw new Error(`SH_SANDBOX_DISCOVERY='${raw}' is not one of pods|records|both`);
  }
  if (raw === 'records' && !remoteSandbox) {
    // Blame the flag, not the pool: without this the caller sees "no Running pods for pool
    // selector '…'", which sends them debugging a healthy pool.
    throw new Error(
      'SH_SANDBOX_DISCOVERY=records requires SH_REMOTE_SANDBOX=1 (records are only read when the remote flag is on)',
    );
  }
  return raw;
}

/** Thrown when a pool is configured but every pod is at the soft cap. */
export class SandboxPoolSaturatedError extends Error {
  constructor(selector: string) {
    super(`sandbox pool '${selector}' saturated: all pods at capacity`);
    this.name = 'SandboxPoolSaturatedError';
  }
}

export interface SelectedSandbox {
  config: K8sSandboxConfig;
  /** Present ONLY for a leased grpc presence record; undefined for pods. */
  transport?: SandboxTransport;
  heartbeat: () => Promise<void>;
  release: () => Promise<void>;
}

export interface SelectDeps {
  listPods?: (
    selector: string,
    namespace: string,
    context?: string,
    run?: RunKubectl,
  ) => Promise<string[]>;
  lease?: LeaseStore;
  run?: RunKubectl;
  /** Mirrored grpc presence records; defaults to a RedisRecordStore. Only consulted when opts.remoteSandbox is true. */
  records?: RecordStore;
  /** Builds the exec client for a leased grpc record; defaults to a real SandboxExecClient at SH_RELAY_ADDR. */
  makeExecClient?: (sandboxId: string) => ExecClientLike;
}

/** Lazily builds a real gRPC exec client — only reached on the grpc branch when the flag is on. */
function defaultExecClient(_sandboxId: string, env: NodeJS.ProcessEnv): ExecClientLike {
  const addr = env.SH_RELAY_ADDR ?? 'sandbox-relay.default.svc.cluster.local:8443';
  return new SandboxExecClient(addr, credentials.createInsecure()) as unknown as ExecClientLike;
}

/**
 * Choose a sandbox pod for a leaf.
 *  - No `KAGENTI_SANDBOX_POOL_SELECTOR` ⇒ fall back to single-pod resolution
 *    (`KAGENTI_SANDBOX_POD`/`_NAME`); returns null if that too is unset (run local tools).
 *  - Pool configured ⇒ list Running pods (plus mirrored grpc records when `opts.remoteSandbox`
 *    is true), pick least-loaded under the soft cap, acquire a lease. Throws
 *    SandboxPoolSaturatedError if every candidate is full.
 *  - `SH_SANDBOX_DISCOVERY` narrows which inventories are consulted (see resolveDiscoverySource).
 */
export async function selectPoolSandbox(
  env: NodeJS.ProcessEnv,
  headCwd: string,
  runId: string,
  opts: { cap: number; ttlMs: number; remoteSandbox?: boolean },
  deps: SelectDeps = {},
): Promise<SelectedSandbox | null> {
  const selector = env.KAGENTI_SANDBOX_POOL_SELECTOR;
  if (!selector) {
    const config = await resolveSandboxConfig(env, headCwd, deps.run);
    return config ? { config, heartbeat: async () => {}, release: async () => {} } : null;
  }

  const namespace = env.KAGENTI_SANDBOX_NAMESPACE ?? 'default';
  const context = env.KAGENTI_SANDBOX_CONTEXT || undefined;
  const podCwd = env.KAGENTI_SANDBOX_CWD ?? '/workspace';
  const list = deps.listPods ?? listPoolPods;
  const lease = deps.lease ?? new RedisLeaseStore(env.REDIS_URL);

  const source = resolveDiscoverySource(env, opts.remoteSandbox === true);
  const pods = source === 'records' ? [] : await list(selector, namespace, context, deps.run);

  // Inertness: when the flag is off, never construct a RedisRecordStore or call .list() —
  // the pod path must stay byte-for-byte identical to today (no extra Redis connection).
  const remoteOn = opts.remoteSandbox === true && source !== 'pods';
  let grpcRecs: SandboxRecord[] = [];
  if (remoteOn) {
    const injected = deps.records;
    if (injected) {
      grpcRecs = await injected.list();
    } else {
      // We constructed this store ourselves (it eagerly opens a Redis
      // connection), so we alone own closing it once we're done listing —
      // an injected deps.records is the caller's connection to manage.
      const store = new RedisRecordStore(env.REDIS_URL);
      grpcRecs = await store.list();
      await store.close();
    }
  }
  const grpcById = new Map(grpcRecs.map((r) => [r.sandboxId, r]));

  const candidates = [...pods, ...grpcRecs.map((r) => r.sandboxId)];
  if (candidates.length === 0) throw new Error(`no Running pods for pool selector '${selector}'`);

  const loads = await Promise.all(
    candidates.map(async (name) => ({ pod: name, active: await lease.load(name) })),
  );
  for (const name of orderByLoad(loads)) {
    if (await lease.acquire(name, opts.cap, runId, opts.ttlMs)) {
      const config: K8sSandboxConfig = { pod: name, namespace, context, podCwd, headCwd };
      const rec = grpcById.get(name);
      const transport = rec
        ? GrpcRelayTransport(
            name,
            (deps.makeExecClient ?? ((id: string) => defaultExecClient(id, env)))(name),
          )
        : undefined;
      return {
        config,
        transport,
        heartbeat: () => lease.heartbeat(name, runId, opts.ttlMs),
        release: () => lease.release(name, runId),
      };
    }
  }
  throw new SandboxPoolSaturatedError(selector);
}
