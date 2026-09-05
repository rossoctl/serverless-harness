import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, parseAllDocuments } from 'yaml';

type EnvVar = { name: string; value?: string };

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEPLOY = resolve(REPO_ROOT, 'deploy/knative');
const WORKER = resolve(REPO_ROOT, 'remote-worker');

const example = () => parse(readFileSync(resolve(DEPLOY, 'worker-example.yaml'), 'utf8'));
const template = () => parse(readFileSync(resolve(WORKER, 'worker-deployment.yaml'), 'utf8'));
const envOf = (dep: any): EnvVar[] => dep.spec.template.spec.containers[0].env;
const get = (dep: any, name: string) => envOf(dep).find((e) => e.name === name)?.value;

// Loud-throw readers for the memory/BufferCap coupling: a reformatted Go constant or a
// malformed manifest value must fail the extraction itself, never limp through as NaN.
const readBufferCapMiB = () => {
  const runnerGo = readFileSync(resolve(WORKER, 'internal/exec/runner.go'), 'utf8');
  const match = /BufferCap = (\d+) \* 1024 \* 1024/.exec(runnerGo);
  if (!match)
    throw new Error(
      'could not find `BufferCap = N * 1024 * 1024` in runner.go — constant reformatted?',
    );
  return Number(match[1]);
};

const readDefaultConcurrency = () => {
  const loopGo = readFileSync(resolve(WORKER, 'internal/session/loop.go'), 'utf8');
  const match = /DefaultConcurrency = (\d+)/.exec(loopGo);
  if (!match)
    throw new Error('could not find `DefaultConcurrency = N` in loop.go — constant reformatted?');
  return Number(match[1]);
};

const readLimitMiB = () => {
  const limit = template().spec.template.spec.containers[0].resources.limits.memory;
  const match = /^(\d+)Mi$/.exec(limit);
  if (!match)
    throw new Error(`resources.limits.memory "${limit}" is not in the expected "<N>Mi" form`);
  return Number(match[1]);
};

describe('worker-example.yaml (the third-party copy-and-edit surface)', () => {
  it('is a single-replica Deployment with matching selector and labels', () => {
    const dep = example();
    expect(dep.kind).toBe('Deployment');
    // One worker per SANDBOX_ID: the relay rejects a second live Attach for the same id,
    // so replicas > 1 would leave every extra pod crash-looping on a rejected Attach.
    expect(dep.spec.replicas).toBe(1);
    expect(dep.spec.selector.matchLabels.app).toBe(dep.spec.template.metadata.labels.app);
  });

  it('carries the three env vars a worker cannot start without', () => {
    const dep = example();
    for (const k of ['SANDBOX_ID', 'RELAY_ADDR', 'SANDBOX_TOKEN']) {
      expect(
        get(dep, k),
        `${k} is read at startup by remote-worker/cmd/worker/main.go`,
      ).toBeTruthy();
    }
  });

  it('points RELAY_ADDR at the port the relay Service actually publishes', () => {
    // A drifted port here is the failure mode with the worst diagnostics: the worker
    // dials, gets connection-refused, backs off, and never appears in presence.
    const relayDocs = parseAllDocuments(
      readFileSync(resolve(DEPLOY, 'relay-deployment.yaml'), 'utf8'),
    ).map((d) => d.toJS());
    const svc = relayDocs.find((o) => o.kind === 'Service');
    const port = svc.spec.ports[0].port;
    expect(get(example(), 'RELAY_ADDR')).toContain(`:${port}`);
  });

  it('is restricted-v2 compatible: non-root, no privilege escalation, all caps dropped', () => {
    const sc = example().spec.template.spec.containers[0].securityContext;
    expect(sc.runAsNonRoot).toBe(true);
    expect(sc.allowPrivilegeEscalation).toBe(false);
    expect(sc.capabilities.drop).toContain('ALL');
    // OpenShift assigns a UID from the namespace range; a hardcoded one breaks the
    // copy-and-edit path for anyone whose image does not use that exact UID.
    expect(sc.runAsUser, 'worker-example.yaml must not pin runAsUser').toBeUndefined();
  });
});

describe('remote-worker/worker-deployment.yaml (the sed-filled gate template)', () => {
  it('keeps every placeholder deploy-incluster.sh substitutes', () => {
    const raw = readFileSync(resolve(WORKER, 'worker-deployment.yaml'), 'utf8');
    // deploy-incluster.sh seds these by exact string; a rename here fails silently and
    // ships a pod with a literal __IMAGE__ reference. __TOKEN__ is deliberately absent --
    // the token arrives by secretKeyRef now (#173), which the next test pins.
    for (const p of ['__NS__', '__IMAGE__', '__SANDBOX_ID__']) {
      expect(raw, `${p} is substituted by remote-worker/deploy-incluster.sh`).toContain(p);
    }
  });

  it('takes SANDBOX_TOKEN from the Secret deploy-incluster.sh creates, never as a literal', () => {
    // A `value: __TOKEN__` sed put the live token into the Deployment spec, `oc describe` and
    // any GitOps mirror of the namespace. The two halves of this -- the manifest's reference
    // and the script's Secret -- are in different files and different languages, so nothing
    // but a check like this keeps them agreeing.
    const tokenEnv = envOf(template()).find((e) => e.name === 'SANDBOX_TOKEN');
    expect(
      tokenEnv,
      'SANDBOX_TOKEN is read at startup by remote-worker/cmd/worker/main.go',
    ).toBeDefined();
    expect(
      tokenEnv!.value,
      'a literal value here is the leak #173 is about -- it persists in the Deployment spec',
    ).toBeUndefined();

    const ref = (tokenEnv as { valueFrom?: { secretKeyRef?: { name?: string; key?: string } } })
      .valueFrom?.secretKeyRef;
    expect(ref, 'SANDBOX_TOKEN must arrive via secretKeyRef').toBeDefined();

    const script = readFileSync(resolve(WORKER, 'deploy-incluster.sh'), 'utf8');
    const name = /^SECRET_NAME="([^"]+)"$/m.exec(script);
    const key = /^SECRET_KEY="([^"]+)"$/m.exec(script);
    if (!name || !key) {
      throw new Error(
        'could not find SECRET_NAME= / SECRET_KEY= in deploy-incluster.sh -- renamed? This ' +
          'check cannot compare what it cannot extract.',
      );
    }
    expect(ref!.name, 'must match the Secret deploy-incluster.sh creates').toBe(name[1]);
    expect(ref!.key, 'must match the key deploy-incluster.sh puts the token under').toBe(key[1]);
  });

  it('sets a memory limit that covers the worst-case buffering of whichever concurrency actually runs', () => {
    // runner.go's BufferCap is a PER-STREAM cap on non-streaming execs, and
    // Exec.streaming=false is the proto3 default (relay-supplied), so a buggy relay
    // reaches the worst case with no privilege. Both files carry this arithmetic in a
    // comment and say "change either side and change the other" — this is the check
    // that makes that true (#173 item 7).
    //
    // Concurrency is whatever actually runs: the manifest's WORKER_MAX_CONCURRENT
    // override if it sets one (today it does not), otherwise loop.go's
    // DefaultConcurrency. This keeps the coupling live the moment someone adds the
    // override, instead of relying on a separate test that only fires once that
    // env var exists.
    const bufferCapMiB = readBufferCapMiB();
    const limitMiB = readLimitMiB();
    const override = get(template(), 'WORKER_MAX_CONCURRENT');

    let concurrency: number;
    let source: string;
    if (override === undefined) {
      concurrency = readDefaultConcurrency();
      source = `loop.go's DefaultConcurrency (${concurrency})`;
    } else {
      if (!/^\d+$/.test(override)) {
        throw new Error(`WORKER_MAX_CONCURRENT="${override}" is not a plain non-negative integer`);
      }
      concurrency = Number(override);
      source = `the manifest's WORKER_MAX_CONCURRENT override (${concurrency})`;
    }

    const worstCaseMiB = 2 * concurrency * bufferCapMiB; // stdout + stderr per exec
    expect(
      limitMiB,
      `limit ${limitMiB}Mi must cover 2 x ${concurrency} x ${bufferCapMiB}MiB = ${worstCaseMiB}MiB of buffering (concurrency from ${source}); a smaller limit is an OOMKill the relay can trigger at will`,
    ).toBeGreaterThanOrEqual(worstCaseMiB);
  });
});
