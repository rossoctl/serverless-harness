import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import type { K8sSandboxConfig } from './config.js';
import type { ExecInPod, SandboxTransport } from './transport.js';
import {
  DEFAULT_EXEC_TIMEOUT_S,
  DEFAULT_OUTPUT_CAP,
  OUTPUT_TRUNCATED_MARKER,
} from './transport.js';
import { CAP_STAGE_FAILED, FrameParser, wrapCommand } from './framing.js';

/** argv for the long-lived session: a bare interactive `bash` (NOT `bash -c`). */
export function buildPersistentKubectlArgs(config: K8sSandboxConfig): string[] {
  const args = ['exec', '-i', '-n', config.namespace];
  if (config.context) args.push('--context', config.context);
  args.push(config.pod, '--', 'bash');
  return args;
}

type SpawnFn = typeof nodeSpawn;

interface Inflight {
  nonce: string;
  /** resolve from a matching frame */
  done: (r: { stdout: Buffer; exitCode: number | null; truncated: boolean }) => void;
  /** channel died → caller retries via fallback */
  fail: (e: Error) => void;
}

/**
 * An ExecInPod backed by ONE long-lived `kubectl exec -i -- bash`. Commands are
 * multiplexed over the framed protocol (framing.ts), one in flight at a time.
 * Channel unavailability (spawn error, mid-command death) transparently retries
 * the op via `deps.fallback`; timeout/abort reject with M2-compatible errors.
 * The session is spawned lazily and torn down by close().
 * NOTE: this transport does NOT stream `opts.onData`; streaming ops (bash, grep) stay on the M2 per-call exec.
 */
export function persistentExecInPod(
  config: K8sSandboxConfig,
  deps: { fallback: ExecInPod; spawn?: SpawnFn; outputCapBytes?: number },
): SandboxTransport {
  const spawnFn = deps.spawn ?? nodeSpawn;
  const outputCap = deps.outputCapBytes ?? DEFAULT_OUTPUT_CAP;
  let child: ChildProcess | null = null;
  let parser = new FrameParser();
  let inflight: Inflight | null = null;
  const queue: Array<() => void> = [];
  let seq = 0;
  let disposed = false;
  // Latched once the pod proves it cannot run our wrapper pipeline (missing `head -c`, or
  // a `head` that rejects it). Not retried: the pod's binaries will not change mid-session,
  // so respawning would fail identically on every op and pay double for it.
  let capStageBroken = false;

  const killChild = () => {
    if (!child) return;
    // Null `child` BEFORE kill() so a synchronous `close` (from kill) re-entering
    // killChild/the close handler sees no child and is a no-op (avoids recursion).
    const c = child;
    child = null;
    try {
      c.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  };

  const pump = () => {
    if (inflight || queue.length === 0) return;
    queue.shift()!();
  };

  // Tear the session down and signal channel failure for any in-flight command.
  const failSession = (err: Error) => {
    killChild();
    parser = new FrameParser();
    const cur = inflight;
    inflight = null;
    cur?.fail(err);
    pump();
  };

  const ensureChild = () => {
    if (child || disposed) return;
    const c = spawnFn('kubectl', buildPersistentKubectlArgs(config), {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child = c;
    c.stdout!.on('data', (d: Buffer) => {
      for (const f of parser.push(d)) {
        if (inflight && f.nonce === inflight.nonce) {
          const cur = inflight;
          inflight = null;
          // The pod capped raw stdout at outputCap + 1 (framing.ts), so one byte past
          // the cap is the evidence that output was cut. Trim to the cap and append the
          // marker, matching the per-call transports' `> cap` trip boundary — though not
          // their byte count: exec.ts and grpc-relay-transport.ts push the whole chunk
          // that crosses the cap before testing `bytes > outputCap`, so their returned
          // stdout can exceed the cap by up to one chunk, whereas this transport trims to
          // exactly `cap`.
          //
          // This RESOLVES rather than calling cur.fail(): fail() retries through
          // deps.fallback (the capped KubectlTransport, per extension.ts:52), so
          // treating a cap trip as a channel failure would re-run the command and flood
          // twice before failing anyway. A cap trip is a result, not a dead channel.
          if (f.exitCode === CAP_STAGE_FAILED) {
            // Our own pipeline broke, not the command. Left unhandled this arrives as
            // empty stdout with exit 0, which `readFile` would return as a successful
            // empty read and Pi's Edit would then write back — truncating the file to
            // zero. Latch it, say so once, and hand this and every later op to the
            // fallback transport, which caps client-side and needs no `head -c`.
            capStageBroken = true;
            // eslint-disable-next-line no-console
            console.warn(
              `[k8s-sandbox] pod ${config.namespace}/${config.pod}: the persistent channel's ` +
                `output-cap stage failed (\`head -c\` missing or not supporting -c, or \`base64\` ` +
                `unavailable). Falling back to per-call exec for all file operations. ` +
                `Check the sandbox image: \`kubectl exec -n ${config.namespace} ${config.pod} -- head -c 1 /dev/null\`.`,
            );
            killChild();
            parser = new FrameParser();
            cur.fail(new Error('persistent channel output-cap stage unavailable'));
            pump();
            continue;
          }
          if (f.stdout.length > outputCap) {
            cur.done({
              stdout: Buffer.concat([
                f.stdout.subarray(0, outputCap),
                Buffer.from(OUTPUT_TRUNCATED_MARKER),
              ]),
              exitCode: null,
              truncated: true,
            });
          } else {
            cur.done({ stdout: f.stdout, exitCode: f.exitCode, truncated: false });
          }
          pump();
        }
      }
    });
    c.on('error', (e) => failSession(e instanceof Error ? e : new Error(String(e))));
    c.on('close', () => {
      if (inflight || queue.length) failSession(new Error('session closed'));
      else child = null;
    });
  };

  const exec: ExecInPod = (command, opts = {}) => {
    if (disposed || capStageBroken) return deps.fallback(command, opts);
    return new Promise((resolve, reject) => {
      const start = () => {
        ensureChild();
        if (!child) {
          // spawn unavailable → fall back
          deps.fallback(command, opts).then(resolve, reject);
          return;
        }
        const nonce = `n${++seq}`;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          opts.signal?.removeEventListener('abort', onAbort);
        };
        // timeout / abort: kill+reset the session and reject (NO fallback).
        const killAndReject = (err: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          inflight = null;
          killChild();
          parser = new FrameParser();
          reject(err);
          pump();
        };
        function onAbort() {
          killAndReject(new Error('aborted'));
        }
        if (opts.signal?.aborted) return killAndReject(new Error('aborted'));
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        // Absent => the shared ceiling (#182); an explicit 0 still means "no timeout at all".
        const timeoutS = opts.timeout ?? DEFAULT_EXEC_TIMEOUT_S;
        if (timeoutS > 0) {
          timer = setTimeout(
            () => killAndReject(new Error(`timeout:${timeoutS}`)),
            timeoutS * 1000,
          );
        }
        inflight = {
          nonce,
          done: (r) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(r);
          },
          fail: () => {
            if (settled) return;
            settled = true;
            cleanup();
            deps.fallback(command, opts).then(resolve, reject);
          },
        };
        try {
          child.stdin!.write(wrapCommand(nonce, command, opts.stdin, outputCap));
        } catch (e) {
          failSession(e instanceof Error ? e : new Error(String(e)));
        }
      };
      queue.push(start);
      pump();
    });
  };

  return {
    exec,
    close: async () => {
      disposed = true;
      try {
        child?.stdin?.end();
      } catch {
        /* noop */
      }
      killChild();
      queue.length = 0;
    },
  };
}
