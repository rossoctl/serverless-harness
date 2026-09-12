import { describe, it, expect, afterEach, vi } from 'vitest';
import { connect } from 'node:net';
import { once } from 'node:events';
import { readConfig } from '../src/config.js';
import { startSupervisor, DEFAULT_WORKER_ENTRY, type Supervisor } from '../src/main.js';

/**
 * The only test that forks the REAL worker at `DEFAULT_WORKER_ENTRY`. Every other integration
 * test substitutes a hand-written `.mjs` fixture, which papers over precisely the things this
 * file exercises: forking a cross-package `.ts` file through inherited `--import tsx` execArgv,
 * `worker.ts`'s `pathToFileURL` main-module guard, its `process.send` presence check, and
 * `handler`'s import graph resolving from a foreign package root.
 *
 * It is also what makes the recorded justification for duplicating `WorkerToSupervisor` across
 * `supervisor/src/pool.ts` and `knative-server/src/worker.ts` true rather than aspirational:
 * the two copies must agree on the wire or these tests fail.
 *
 * It also depends on vitest's default per-file process isolation (`pool: 'forks'`,
 * `isolate: true` -- neither this package's `vitest.config.ts` nor any workspace-root
 * config overrides either, so both are vitest 2.x's defaults, not a setting pinned here).
 * `withRealWorker` below mutates `process.execArgv` directly on the running process rather
 * than threading a test-only option through `startSupervisor`; that mutation is safe only
 * because vitest gives each test file its own process. A future move to `pool: 'threads'`
 * (or an explicit `isolate: false`) would let this file's `process.execArgv` mutation leak
 * into whichever sibling test file happens to share its worker thread -- silently, and the
 * failure would surface in that other file's `fork()` calls, not in this one.
 */

/**
 * Production runs `node --import tsx src/main.ts` and `fork()` inherits execArgv, which is how
 * a TypeScript worker starts with no second loader flag. Under vitest the parent's execArgv is
 * `['--conditions', 'development', ...]` with no loader, and a bare `node worker.ts` dies with
 * `ERR_INVALID_TYPESCRIPT_SYNTAX` on `TurnCounter`'s parameter property (Node's strip-only mode
 * cannot compile it). Setting execArgv here exercises the real inheritance path rather than
 * adding a test-only option to `startSupervisor`.
 */
async function withRealWorker(
  config: Record<string, string>,
  /**
   * Variables the WORKER reads. `main.ts` forks with `{ ...process.env }`, so `readConfig`'s
   * argument below reaches the supervisor only -- anything the worker itself reads has to be on
   * `process.env`.
   */
  workerEnv: Record<string, string> = {},
): Promise<{ sup: Supervisor; restore: () => void }> {
  const savedArgv = process.execArgv;
  const savedEnv = Object.keys(workerEnv).map((k) => [k, process.env[k]] as const);
  process.execArgv = ['--import', 'tsx'];
  for (const [k, v] of Object.entries(workerEnv)) process.env[k] = v;
  // Restored in afterEach rather than here: a worker restart mid-test forks again and must
  // inherit the loader too.
  const restore = (): void => {
    process.execArgv = savedArgv;
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    const sup = await startSupervisor({
      config: readConfig({
        PORT: '0',
        SH_ADMIN_PORT: '0',
        SH_WORKERS: '1',
        ...config,
      } as NodeJS.ProcessEnv),
      // workerEntry deliberately OMITTED: this is the point of the file.
      log: () => {},
    });
    return { sup, restore };
  } catch (err) {
    restore();
    throw err;
  }
}

/** Waits for the single worker to report `ready`. */
async function waitReady(sup: Supervisor): Promise<void> {
  await vi.waitFor(() => expect(sup.pool.views().filter((v) => v.healthy)).toHaveLength(1), {
    timeout: 30_000,
  });
}

/** One request on its own connection, read to completion. */
async function speak(port: number, request: string): Promise<string> {
  const socket = connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(request);
  const chunks: Buffer[] = [];
  socket.on('data', (c: Buffer) => chunks.push(c));
  await once(socket, 'end');
  socket.destroy();
  return Buffer.concat(chunks).toString('utf8');
}

const HEALTH = 'GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n';

let sup: Supervisor | undefined;
let restore: (() => void) | undefined;
afterEach(async () => {
  await sup?.close();
  sup = undefined;
  restore?.();
  restore = undefined;
});

describe('the real worker, forked from DEFAULT_WORKER_ENTRY', () => {
  it('is the default entry, and forking it brings a worker up over IPC', async () => {
    // `DEFAULT_WORKER_ENTRY` had ZERO test references, so the highest-risk integration in the
    // slice ran only on a real VM.
    expect(DEFAULT_WORKER_ENTRY).toMatch(/knative-server[/\\]src[/\\]worker\.ts$/);

    ({ sup, restore } = await withRealWorker({ SH_TURNS_PER_WORKER: '8' }));
    await waitReady(sup!);

    // `ready` arriving at all is the conjunction of four things the fixtures never test:
    // execArgv inheritance loaded the TypeScript loader; `pathToFileURL(process.argv[1]).href`
    // matched `import.meta.url`, so the main-module block ran at all; `--role=turn` parsed
    // (any other role exits 2); and `process.send` was present (its absence exits 2). It also
    // means `handler`'s whole import graph resolved from a foreign package root.
    const [w] = sup!.pool.telemetry();
    expect(w!.pid).toBeGreaterThan(0);
    expect(w!.pid).not.toBe(process.pid);
  }, 60_000);

  it('serves a non-turn request through a handed-off socket', async () => {
    ({ sup, restore } = await withRealWorker({ SH_TURNS_PER_WORKER: '8' }));
    await waitReady(sup!);
    // `GET /health` is the furthest a test can drive the real handler with no infrastructure:
    // it answers from `server.ts` directly, touching neither Redis nor a sandbox nor a model.
    // A real `POST /turn` would need Redis, a sandbox and a model endpoint, so it stays a live
    // smoke concern -- see the report for exactly what this does and does not protect.
    expect(await speak(sup!.port, HEALTH)).toContain('200 OK');
  }, 60_000);

  it('agrees with the supervisor on all four IPC rows', async () => {
    // `WorkerToSupervisor` is duplicated verbatim in `supervisor/src/pool.ts` and
    // `knative-server/src/worker.ts`, deliberately (spec §9). The recorded justification says
    // drift "fails a test rather than rotting" -- which only became true once something forked
    // a real worker. This is that test: every row crosses the boundary here.
    ({ sup, restore } = await withRealWorker(
      { SH_TURNS_PER_WORKER: '8' },
      { SH_STATS_INTERVAL_MS: '50' },
    ));

    // 'ready'
    await waitReady(sup!);

    // 'stats' -- the advisory fourth row: recorded for /metrics, never routed on.
    await vi.waitFor(() => expect(Number.isFinite(sup!.pool.telemetry()[0]!.rssBytes)).toBe(true), {
      timeout: 15_000,
    });
    // ...and `views()` is still exactly §3.9's three fields, whatever telemetry arrived.
    expect(sup!.pool.views()[0]).toEqual({ id: 0, inFlight: 0, healthy: true });

    // 'load' -- from the served connection's close report.
    expect(await speak(sup!.port, HEALTH)).toContain('200 OK');
    await vi.waitFor(() => expect(sup!.pool.views()[0]!.inFlight).toBe(0));

    // 'draining' -- the supervisor sends `drain`, the real worker answers `draining`, and the
    // pool stops routing to it without killing it.
    sup!.pool.drainAll();
    await vi.waitFor(() => expect(sup!.pool.views()[0]!.healthy).toBe(false), { timeout: 15_000 });
  }, 60_000);

  it('does not wedge into permanent 429s after non-turn connections at S=1', async () => {
    // THE regression pin for the monotonic-estimate defect. `handOff` credits +1 per admitted
    // CONNECTION while the worker reports `load` only from its TURN counter, and a non-turn
    // request never touches that counter. So each `GET /health` used to raise the estimate by
    // one permanently: at S=1 the second connection was refused before hand-off, so no turn
    // could ever arrive to reconcile, and the pool stayed wedged in 429s until a worker
    // crashed. `setup-vm.sh`'s own closing health check burned one unit per invocation.
    //
    // Driven against the REAL worker on purpose: the `.mjs` fixtures re-implement the IPC
    // contract by hand and papered this over.
    ({ sup, restore } = await withRealWorker({ SH_TURNS_PER_WORKER: '1' }));
    await waitReady(sup!);

    for (let i = 1; i <= 4; i += 1) {
      expect(await speak(sup!.port, HEALTH), `connection ${i}`).toContain('200 OK');
      // The estimate must come back down, or connection i+1 is refused before hand-off.
      await vi.waitFor(() => expect(sup!.pool.views()[0]!.inFlight).toBe(0), { timeout: 5000 });
    }
  }, 60_000);
});
