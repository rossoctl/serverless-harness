/**
 * The exec seam Pi sees (spec §3). Everything above `select-sandbox`
 * (`run-leaf`, `run-turn`, `converge`) depends only on `SandboxTransport` and
 * never learns how bytes reach the sandbox. Implementations: `KubectlTransport`
 * (per-call kubectl exec), `GrpcRelayTransport` (added in ST3), and
 * `persistentExecInPod` (one long-lived channel, serving the file tools) — all three
 * are capped at DEFAULT_OUTPUT_CAP, each by its own mechanism (spec §8).
 */

/**
 * The result of one exec through the seam.
 *
 * `truncated` is REQUIRED, not optional. An optional field lets a fourth transport omit
 * it and read as "not truncated", silently reintroducing the divergence #180/#185 are
 * about; required, it is a compile error. The invariant `truncated === true ⇒
 * exitCode === null` is asserted for every implementation by test/conformance.ts.
 *
 * `exitCode: null` is retained on truncation for backward compatibility: every caller
 * that checks `!== 0` keeps failing closed, so there is no flag day. The flag adds
 * precision — `truncated: false` with `exitCode: null` now unambiguously means "no exit
 * status, and NOT because of our cap" (a signalled process; gRPC `end.exitCode < 0`; a
 * stream that ended without an `End` frame).
 */
export interface ExecResult {
  stdout: Buffer;
  exitCode: number | null;
  /**
   * The seam's output cap tripped (spec §8). `stdout` is incomplete and ends with
   * OUTPUT_TRUNCATED_MARKER, the producer was stopped, and `exitCode` is null.
   */
  truncated: boolean;
}

/**
 * One command run in the sandbox (`bash -c <command>`). stdout is collected and
 * returned; stderr is streamed to `onData` (with stdout) but NOT included in the
 * returned `stdout`, so file ops get clean bytes. `stdin` feeds data (e.g. base64
 * for writes); `onData` streams output for bash; `signal` aborts; `timeout` is seconds.
 */
export type ExecInPod = (
  command: string,
  opts?: {
    stdin?: Buffer;
    onData?: (chunk: Buffer) => void;
    signal?: AbortSignal;
    timeout?: number; // seconds
  },
) => Promise<ExecResult>;

/** A transport-blind exec channel to one sandbox (spec §3). */
export interface SandboxTransport {
  exec: ExecInPod;
  /** Release any long-lived resource (persistent channel, connection). Idempotent. */
  close(): Promise<void>;
}

/**
 * Total returned-stdout cap per exec (spec §8, "poisoned-output defense"). Enforced by
 * ALL THREE `SandboxTransport` implementations, each by its own mechanism, which it
 * declares to the shared battery (test/conformance.ts):
 *
 *  - `KubectlTransport`     `local-kill`        SIGKILLs its `kubectl exec` client
 *  - `GrpcRelayTransport`   `remote-abort`      `Abort` → the worker kills the process group
 *  - `persistentExecInPod`  `producer-side-cap` pod-side `head -c` bounds output at the source
 *
 * On a trip each truncates, appends OUTPUT_TRUNCATED_MARKER, and sets
 * `truncated: true` with a null exit code. The battery asserts the invariant and the
 * declared mechanism for every implementation, so none can regress alone.
 *
 * The Go worker's BufferCap (remote-worker/internal/exec/runner.go) is pinned to this
 * value — change one and change the other; test/output-cap-coupling.test.ts enforces it.
 */
export const DEFAULT_OUTPUT_CAP = 8 * 1024 * 1024; // 8 MiB

/** Appended to returned stdout when the cap trips, so Pi sees the truncation. */
export const OUTPUT_TRUNCATED_MARKER = '\n[output truncated]';

/**
 * Ceiling on one exec when the caller names no `timeout` (spec §3; issue #182). Shared by
 * ALL THREE implementations, for the same reason DEFAULT_OUTPUT_CAP is: an exec that
 * behaves differently depending on which transport happened to serve it is a divergence
 * the caller above the seam cannot see or control.
 *
 * The three used to disagree. `KubectlTransport` and `persistentExecInPod` armed no timer
 * at all, so a command with no timeout ran unbounded; `GrpcRelayTransport` applied 120 s.
 * Pi's bash tool declares `timeout` optional and tells the model there is "no default
 * timeout", so omitting it is the ordinary case, not an edge one — the same model-issued
 * `bash` ran forever on a pod and died after two minutes through a relay.
 *
 * This is deliberately generous. It exists to stop an exec leaking a slot forever, NOT to
 * police how long a command may legitimately take: a cold `npm ci`, a full test suite or a
 * container build can all outrun a two-minute budget, and the relay's 120 s default was low
 * enough to fail those on the remote path only. Callers that know better still pass their
 * own `timeout`, and `timeout: 0` explicitly opts out (the ceiling applies only when the
 * option is absent).
 *
 * `GrpcRelayTransport` also sends this as the request's `timeout_s`, so the worker holds the
 * same budget independently. It is the only transport whose process is remote: the other two
 * time out a child in their own process, which cannot outlive the timer, whereas a harness
 * that exits mid-exec would otherwise leave a remote process with nothing left to stop it.
 *
 * Pinned for every implementation by test/conformance.ts (and, for the wire value,
 * test/grpc-relay-transport.test.ts), so none can drift back.
 */
export const DEFAULT_EXEC_TIMEOUT_S = 30 * 60; // 30 minutes
