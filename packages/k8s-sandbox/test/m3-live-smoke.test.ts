import { spawn as nodeSpawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import type { K8sSandboxConfig } from '../src/config.js';
import { KubectlTransport } from '../src/exec.js';
import { persistentExecInPod } from '../src/persistent-exec.js';
import {
  createPodBashOps,
  createPodFindOps,
  createPodLsOps,
  createPodReadOps,
  createPodWriteOps,
} from '../src/operations.js';

const execFileP = promisify(execFile);

// Gate: this suite hits a REAL kind cluster and is skip-by-default. It only runs
// when M3_LIVE_SMOKE is set, so `pnpm test`/CI never executes it.
const LIVE = !!process.env.M3_LIVE_SMOKE;

// Construct the config directly (mirrors the unit-test fixture) so path mapping
// is deterministic: head path /head/X maps to pod path /workspace/X.
const cfg: K8sSandboxConfig = {
  pod: process.env.KAGENTI_SANDBOX_POD ?? '',
  namespace: process.env.KAGENTI_SANDBOX_NAMESPACE ?? 'default',
  // Unset => undefined => kubectl's current-context, matching what config.ts and
  // resolve-pod.ts already do with this variable and what the README documents as the
  // default. The old `?? 'kind-kagenti'` literal pinned one developer's cluster name, so on
  // any other cluster the suite failed against a context that does not exist rather than
  // running where the operator was already pointed (#192).
  context: process.env.KAGENTI_SANDBOX_CONTEXT || undefined,
  podCwd: '/workspace',
  headCwd: '/head',
};

/** Direct `kubectl exec` into the pod (independent verification path). */
async function kubectlExecRaw(args: string[]): Promise<string> {
  const base = ['exec', '-n', cfg.namespace];
  if (cfg.context) base.push('--context', cfg.context);
  base.push(cfg.pod, '--', ...args);
  const { stdout } = await execFileP('kubectl', base, { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

describe.skipIf(!LIVE)('M3 live smoke (real kind cluster)', () => {
  // Seed the find fixtures this suite reads. Claims 1, 4 and 5 assert on a `.gitignore`
  // and a tree of seeded `.ts` files that they do NOT create themselves — Claims 2 and 4b
  // build their own, which is why they pass on a bare pod while the others do not.
  //
  // This used to be a manual step in SMOKE.md, and skipping it is actively misleading:
  // the symptoms are `Read failed in pod (cat exited 1): /head/.gitignore` and
  // `glob result: []`, which look exactly like regressions in the read/glob paths rather
  // than like absent fixtures. A pod restart is enough to lose the content, so the suite
  // seeds itself instead of depending on operator memory.
  //
  // Idempotent by construction (`mkdir -p`, `>` truncating redirects), so re-runs and a
  // partially-seeded workspace are both fine. `/workspace` is used because the pod runs
  // as an arbitrary non-root UID and `/tmp` is not writable.
  beforeAll(async () => {
    await kubectlExecRaw([
      'bash',
      '-c',
      'cd /workspace && mkdir -p src node_modules/pkg .git dist && ' +
        'printf "node_modules/\ndist/\n" > .gitignore && ' +
        ': > src/keep.ts && : > node_modules/pkg/skip.ts && : > .git/cfg.ts && ' +
        ': > dist/bundle.ts && : > top.ts',
    ]);
  }, 60_000);

  it('Claim 1: a single persistent process serves a burst of >=3 ops', async () => {
    let spawnCount = 0;
    const countingSpawn = ((...a: Parameters<typeof nodeSpawn>) => {
      spawnCount += 1;
      return nodeSpawn(...a);
    }) as typeof nodeSpawn;

    const fastExec = persistentExecInPod(cfg, {
      fallback: KubectlTransport(cfg).exec,
      spawn: countingSpawn,
    });
    try {
      const read = createPodReadOps(fastExec.exec, cfg);
      const ls = createPodLsOps(fastExec.exec, cfg);
      const find = createPodFindOps(fastExec.exec, cfg);

      // BURST: run >=3 ops sequentially, all over the same persistent channel.
      // NOTE: the seeded .ts files are 0 bytes, so we assert presence of the
      // *.gitignore* read (non-empty) and structural results for ls/glob;
      // content length of empty files is intentionally not asserted.
      const gi = await read.readFile('/head/.gitignore');
      const listing = await ls.readdir('/head');
      const globbed = await find.glob('*.ts', '/head', {
        ignore: ['**/node_modules/**', '**/.git/**'],
        limit: 100,
      });
      const gi2 = await read.readFile('/head/.gitignore');

      expect(gi.length).toBeGreaterThan(0);
      expect(listing.length).toBeGreaterThan(0);
      expect(globbed.length).toBeGreaterThan(0);
      expect(gi2.length).toBeGreaterThan(0);
      expect(gi2.toString()).toBe(gi.toString());

      // The whole burst must have been served by exactly ONE kubectl process.
      expect(spawnCount).toBe(1);
      // eslint-disable-next-line no-console
      console.log(`[Claim1] spawnCount=${spawnCount} (burst of 4 ops)`);
    } finally {
      await fastExec.close();
    }
  }, 30000);

  it('Claim 2 (TOP): write/edit over the persistent channel round-trips multi-line/special content', async () => {
    const fastExec = persistentExecInPod(cfg, { fallback: KubectlTransport(cfg).exec });
    const headPath = '/head/m3-write.txt';
    const podPath = '/workspace/m3-write.txt';
    const content = 'line1\nline2 with "quotes" and $dollar and `backtick`\nline3 end\n';
    try {
      const write = createPodWriteOps(fastExec.exec, cfg);
      const read = createPodReadOps(fastExec.exec, cfg);

      // Must NOT hang (the pre-fix heredoc-delimiter bug hung here). The 30s
      // test timeout would fail the test if it did.
      await write.writeFile(headPath, content);

      // Read back over the persistent channel.
      const roundTrip = (await read.readFile(headPath)).toString();
      expect(roundTrip).toBe(content);

      // Independently confirm with a direct kubectl exec cat.
      const direct = await kubectlExecRaw(['cat', podPath]);
      expect(direct).toBe(content);

      // eslint-disable-next-line no-console
      console.log(`[Claim2] write round-trip OK; bytes=${Buffer.from(content).length}`);
    } finally {
      await fastExec.close();
    }
  }, 30000);

  it('Claim 3: env injection reaches the bash op', async () => {
    const streamExec = KubectlTransport(cfg).exec;
    const bash = createPodBashOps(streamExec, cfg);
    const chunks: Buffer[] = [];
    const r = await bash.exec('echo MARKER=$M3_SMOKE', '/head', {
      onData: (d) => chunks.push(d),
      env: { M3_SMOKE: 'works-42' },
    });
    const out = Buffer.concat(chunks).toString();
    expect(r.exitCode).toBe(0);
    expect(out).toContain('MARKER=works-42');
    const line = out.split('\n').find((l) => l.includes('MARKER=')) ?? out.trim();
    // eslint-disable-next-line no-console
    console.log(`[Claim3] captured: ${line.trim()}`);
  }, 30000);

  it("Claim 4: glob honours ignore-list; a gitignored DIRECTORY (dist/) is pruned even with -g '*.ts'", async () => {
    const fastExec = persistentExecInPod(cfg, { fallback: KubectlTransport(cfg).exec });
    try {
      const find = createPodFindOps(fastExec.exec, cfg);
      const results = await find.glob('*.ts', '/head', {
        ignore: ['**/node_modules/**', '**/.git/**'],
        limit: 100,
      });
      const set = new Set(results);
      // eslint-disable-next-line no-console
      console.log(`[Claim4] glob result: ${JSON.stringify(results)}`);

      // Included: regular tracked files.
      expect(set.has('src/keep.ts')).toBe(true);
      expect(set.has('top.ts')).toBe(true);
      // Excluded: in the ignore-list / rg built-ins.
      expect(set.has('node_modules/pkg/skip.ts')).toBe(false);
      expect(set.has('.git/cfg.ts')).toBe(false);

      // ── gitignored DIRECTORY case (the nuance) ────────────────────────────
      // operations.ts notes that a positive `-g <pattern>` is a ripgrep
      // whitelist that can override .gitignore. That override is real, but it
      // is FILE-level only (proven in Claim 4b). It does NOT resurrect files
      // inside a gitignored *directory*: when `.gitignore` contains `dist/`,
      // ripgrep PRUNES the whole `dist/` directory before the `-g '*.ts'`
      // whitelist is ever consulted, so `dist/bundle.ts` stays excluded even
      // though `*.ts` matches it. (Only `rg --files -uu`/`--no-ignore-vcs`
      // would surface it.) Assert the dir-prune behaviour here; the file-level
      // override is asserted separately in Claim 4b.
      const distVisible = set.has('dist/bundle.ts');
      // eslint-disable-next-line no-console
      console.log(
        `[Claim4] dist/bundle.ts visible via -g glob = ${distVisible} ` +
          `(gitignored DIRECTORY dist/ is pruned before -g whitelist applies -> false)`,
      );
      expect(distVisible).toBe(false);
    } finally {
      await fastExec.close();
    }
  }, 30000);

  it('Claim 4b: positive -g whitelist-overrides a file-level .gitignore (verified nuance)', async () => {
    const fastExec = persistentExecInPod(cfg, { fallback: KubectlTransport(cfg).exec });
    try {
      // Seed an ISOLATED fixture (does not touch the shared /workspace files):
      // /workspace/ovr/{a.ts, keep2.ts, .gitignore} where .gitignore ignores
      // the file `a.ts` by name. A positive `-g '*.ts'` should whitelist-override
      // that FILE-level ignore (unlike the DIRECTORY-prune case in Claim 4).
      await kubectlExecRaw([
        'bash',
        '-lc',
        'mkdir -p /workspace/ovr && ' +
          ': > /workspace/ovr/a.ts && ' +
          ': > /workspace/ovr/keep2.ts && ' +
          "printf 'a.ts\\n' > /workspace/ovr/.gitignore",
      ]);

      const find = createPodFindOps(fastExec.exec, cfg);
      // cwd /head/ovr maps to /workspace/ovr; empty ignore-list so ONLY
      // .gitignore is in play.
      const results = await find.glob('*.ts', '/head/ovr', {
        ignore: [],
        limit: 100,
      });
      const set = new Set(results);
      // eslint-disable-next-line no-console
      console.log(`[Claim4b] glob result: ${JSON.stringify(results)}`);

      // a.ts is gitignored by name, but the positive -g '*.ts' whitelist
      // overrides a FILE-level ignore -> it reappears.
      expect(set.has('a.ts')).toBe(true);
      // keep2.ts is not ignored at all.
      expect(set.has('keep2.ts')).toBe(true);
    } finally {
      await kubectlExecRaw(['rm', '-rf', '/workspace/ovr']);
      await fastExec.close();
    }
  }, 30000);

  it('Claim 5: close is non-throwing (best-effort process-count probe)', async () => {
    const fastExec = persistentExecInPod(cfg, { fallback: KubectlTransport(cfg).exec });
    // Warm the channel so a persistent bash exists in the pod.
    await createPodReadOps(fastExec.exec, cfg).readFile('/head/.gitignore');

    const countBash = async (): Promise<number> => {
      try {
        const out = await kubectlExecRaw([
          'sh',
          '-c',
          'ps -o pid,args 2>/dev/null | grep -c "[b]ash"',
        ]);
        return parseInt(out.trim(), 10) || 0;
      } catch {
        return -1;
      }
    };

    const before = await countBash();
    await expect(fastExec.close()).resolves.toBeUndefined();
    // Give the kill a moment to propagate.
    await new Promise((res) => setTimeout(res, 1500));
    const after = await countBash();

    // eslint-disable-next-line no-console
    console.log(`[Claim5] bash-process count before=${before} after=${after} (informational)`);
  }, 30000);

  it('Claim 6: a file over the output cap fails the read loudly, with a usable message', async () => {
    // The one change with no hermetic proxy: a real `head -c` in a real pipeline, over
    // kubectl exec, against the sandbox image's coreutils. The unit tests prove the
    // command shape and the client half; only this proves they compose in the pod.
    const t = persistentExecInPod(cfg, { fallback: KubectlTransport(cfg).exec });
    try {
      const big = '/workspace/cap-probe.bin';
      // 9 MiB > the 8 MiB cap, written in-pod so no large payload crosses the wire.
      await kubectlExecRaw(['bash', '-c', `head -c 9437184 /dev/zero > ${big}`]);
      const read = createPodReadOps(t.exec, cfg);
      // One read, three assertions: re-invoking would push 9 MiB through the pod's
      // pipeline three times for no extra coverage.
      const err = (await read.readFile('/head/cap-probe.bin').catch((e) => e)) as Error;
      expect(err.message).toMatch(/exceeds the .* output cap/);
      // The message must carry the size and the escape hatch, or the model cannot act.
      expect(err.message).toMatch(/9437184/);
      expect(err.message).toMatch(/sed -n/);

      // A file just under the cap must still read cleanly — the cap must not have made
      // the whole path fragile.
      const small = '/workspace/cap-probe-small.bin';
      await kubectlExecRaw(['bash', '-c', `head -c 1048576 /dev/zero > ${small}`]);
      const buf = await read.readFile('/head/cap-probe-small.bin');
      expect(buf.length).toBe(1048576);

      // And bash reports the kill rather than success (#181), over the same real pod.
      const bash = createPodBashOps(KubectlTransport(cfg).exec, cfg);
      const r = await bash.exec(`cat ${big}`, '/head', { onData: () => {} });
      expect(r.exitCode).toBe(137);
    } finally {
      await t.close();
      await kubectlExecRaw([
        'bash',
        '-c',
        'rm -f /workspace/cap-probe.bin /workspace/cap-probe-small.bin',
      ]).catch(() => {});
    }
  }, 120_000);
});
