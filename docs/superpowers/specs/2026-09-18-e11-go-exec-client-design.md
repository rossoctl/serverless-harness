# E11 density: a persistent-connection Go Exec client (issue #294)

Issue #291 deferred its item 3 — replacing `grpcurl` with a persistent-connection Go
client — on the explicit grounds that committing to it before measuring would be a guess.
The control arm PR #293 added supplied the measurement, and the answer is yes. This spec
covers building the client. It does not cover running the sweep that the client makes
worth booking.

## Problem

On the bare-metal rig (`srv-r16b14s16`, 72 cpu / 754 GiB, `virt: none`, governor
`performance`), the `driver-control` arm — no relay, no Redis, no worker, no VMM, and a
server that answers every Exec with one `End` and executes nothing — produced this ladder
at `ITERS_PER_SLOT=200`, `SAMPLE_INTERVAL_MS=250`:

| c     | tput/s    | p95    | hostCpuFraction | hostCpuFractionPeak | coresBusy /72 | hostCpuSamples |
| ----- | --------- | ------ | --------------- | ------------------- | ------------- | -------------- |
| 1     | 56.8      | 17 ms  | 0.0204          | 0.0253              | 1.47          | 15             |
| 2     | 101.3     | 19 ms  | 0.0411          | 0.0470              | 2.96          | 17             |
| 4     | 171.6     | 25 ms  | 0.0879          | 0.1050              | 6.33          | 20             |
| **8** | **241.6** | 44 ms  | 0.2017          | 0.2131              | 14.52         | 25             |
| 16    | 219.6     | 137 ms | 0.4163          | 0.4864              | 29.97         | 46             |
| 32    | 204.9     | 340 ms | 0.7564          | 0.8069              | 54.46         | 72             |
| 64    | 231.6     | 753 ms | 0.8907          | 0.9598              | 64.13         | 103            |

Every millisecond and every cycle in that table is driver overhead. Three things follow.

1. **The driver alone has a knee at `c=8`.** Throughput peaks there and then declines
   while p95 grows 44x. That is the same knee position and the same curve shape
   `EXPERIMENTS.md` §E11 published for _both_ real arms.
2. **The driver alone saturates a 72-cpu host.** At `c=64` it burns 64 of 72 cores and its
   CPU peak reaches 0.9598, crossing the 0.9 threshold `crosses('cpu')` tests. A sweep
   cannot attribute a resource bound to a backend while the load generator is consuming
   the resource.
3. **The driver's own p95 is ~45% of the published microVM arm's.** 753 ms of the published
   1686 ms at `c=64` is driver cost, before the backend does anything. The two figures are
   not the same instrument twice: 753 ms is PR #293's repaired driver at
   `ITERS_PER_SLOT=200`; 1686 ms is the pre-#291 driver at `ITERS_PER_SLOT=20`. That
   mismatch runs in this finding's favor, not against it — the older, costlier driver's
   share of 1686 ms was probably larger, not smaller.

The cost is one `execve` per Exec. PR #293 removed the ~8 other spawns per Exec (two of
them Python interpreters); the remaining one is `grpcurl`, and each invocation re-parses
the proto descriptor set and opens a fresh TCP connection and HTTP/2 session before
sending a single request.

### Additional finding, beyond the issue

`packages/sandbox-relay/src/relay.ts`'s `routeExec` yields an in-stream
`ExecEvent.error` and then returns normally, which is a gRPC **OK** status. `grpcurl`
exits 0, so `grpc_exec_record` records `ok`: today an `ExecError`-failed Exec counts
toward `throughput`, enters the distribution `p95` is taken over, and never appears in
`execErrorsByCause`. This is a pre-existing defect in the bash path, found while reading
the wire contract for this work.

It does not touch this issue's comparison. The null-responder only ever sends `End`, so
on the `driver-control` arm the two drivers are identical by construction, and the Go
client can classify `ExecEvent.error` correctly at zero cost to the single-variable
comparison. It is therefore fixed on the Go path, disclosed in the record, and reported
for its own issue rather than folded in silently. Filed as #295.

## Non-goals

- **Open-loop / rate-based driving.** The issue notes this client makes it cheap, and the
  design doc records it as viable only once item 3 exists. It stays a separate change so
  that one variable moves when these numbers are compared against the table above.
  `drivingModel` stays `closed-loop-per-slot` with its declared coordinated-omission bias.
- **Flipping the default.** The issue is explicit: opt-in, "so the bash path stays the
  reference until the two are compared on the same host".
- **Converge.** Phase 1 is already outside the timed window and reported separately as
  `convergeMsP50`. ~12 ms of client cost is noise against a measured 383-485 ms git fetch,
  and moving it would change a number this work is not measuring.
- **Running the sweep.** The authoritative comparison belongs on the host that produced
  the table. This spec ends at a client that is proven equivalent and ready to drive.
- **New codegen.** The client builds against the existing `gen/go/sandbox/v1` stubs, the
  same package `cmd/null-responder` already uses.

## Design

### 1. A new binary: `remote-worker/cmd/exec-driver`

Four small files, each with one job:

| File       | Responsibility                                                 |
| ---------- | -------------------------------------------------------------- |
| `main.go`  | flags, plan load, exit status                                  |
| `plan.go`  | the plan struct and its validation refusals                    |
| `drive.go` | dial once, `c` goroutines, per-Exec timing, times-file writing |
| `cause.go` | error-cause classification                                     |

`cause.go` is separate because it is a deliberate mirror of a contract that lives in
another language, and a mirror deserves a file a reader can diff against its original.

### 2. The bash to Go boundary is a plan file

`run_density_rung` writes one JSON plan per rung with `python3`, **before `wall_t0` is
stamped**, and `exec-driver --plan <path>` reads it:

```json
{
  "target": "localhost:8445",
  "sandboxId": "e11-driver-control",
  "itersPerSlot": 200,
  "warmupPerSlot": 3,
  "execTimeoutS": 30,
  "callDeadlineS": 45,
  "mix": ["true", "head -c 1048576 /dev/zero | wc -c", "..."],
  "slots": [
    {
      "reqBase": 1000000,
      "workspaceKey": "",
      "timesFile": "…/slot-1.times",
      "errFile": "…/slot-1.err"
    }
  ]
}
```

Two alternatives were considered and rejected:

- **Flags plus the mix on stdin.** No JSON and no `python3`, but per-slot workspace keys
  are `slot_run_id` output on the microvm arm, so it needs either a naming template in Go
  — coupling Go to bash's `slot_run_id`, the drift the one-place helpers exist to prevent
  — or 64 repeated flags. It also depends silently on mix commands staying newline-free,
  which nothing enforces.
- **Go computing slot identity itself.** Fewest arguments, but it reimplements
  `slot_run_id` / `slot_req_base` / `slot_workspace_key` in a second language. Phase 2
  already _recomputes_ identity from those helpers precisely so the derivations cannot
  drift into two slots sharing a workspace or a `req_id`, and a `req_id` collision once
  left a run wedged for 33 minutes.

The plan file keeps every escape inside `json.dumps`, which is already this driver's
idiom; it makes the Go side testable from a golden plan; and it survives a refused rung as
an artifact an operator can read.

### 3. Timing and the wire contract

One `grpc.ClientConn` for the whole rung, dialled and brought to `READY` before any
goroutine starts, so no dial cost can land inside a measured Exec. Then one goroutine per
slot, and for call `i` of `itersPerSlot + warmupPerSlot`:

- `req_id = reqBase + 1 + i`. This matches bash exactly: `grpc_exec_record`'s caller
  increments before each call, so the first Exec is `base+1` and converge already used
  `base` itself.
- command `mix[i % len(mix)]`, which reproduces bash's cycle-and-truncate over the mix.
- `t0` read, `Exec` called, the stream `Recv`d **until `io.EOF`**, `t1` read. Draining to
  EOF is what `grpcurl` does; stopping at `End` would shorten measured latency for a
  reason that has nothing to do with the change being measured.
- a per-call `context.WithTimeout(callDeadlineS)` filling `-max-time`'s role, so a wedged
  Exec fails one rung instead of hanging the ladder.

Each call appends one line to its slot's `slot-$i.times` in the existing
`<ms> <status> <cause>` format, in issue order. That is the whole point of the shape:
warmup trimming, `percentile`, `execErrorsByCause`, the sampler bracket and the record
writer are untouched.

**Post-review addendum:** both `grpc_exec_record` and this client now record `ms` to
three decimal places (integer-exact, from microseconds, no floating point on either
path) instead of whole milliseconds — required because the Go client's per-Exec latency
is sub-millisecond, which int64 truncation rounded to `0` almost every time. Records
written before this change carry integer `ms`.

Per-Exec errors are **recorded, not fatal** — matching `grpc_exec_record`, which never
returns non-zero. The binary exits non-zero only on a setup failure: an unreadable plan,
a failed dial, an unwritable times file. `run_density_rung` already turns that into the
refusal that keeps a half-measured rung out of the record.

### 4. Cause vocabulary

The same ordered substring rules `grpc_exec_record` greps for, applied to the gRPC status
message or to `ExecError.message`:

| Substring (case-insensitive)      | Cause                  |
| --------------------------------- | ---------------------- |
| `workspace_key`                   | `empty-workspace-key`  |
| `mem`                             | `memory-gate`          |
| `maxruns`, `max-runs`, `max_runs` | `max-runs`             |
| `spawn`                           | `spawn-failure`        |
| `vsock`                           | `vsock-short-response` |
| none of the above                 | `unknown`              |

The order is load-bearing and is preserved. A client-side deadline matches nothing and
lands in `unknown` on both paths. Failing Execs also append their error text to
`slot-$i.err`, so the operator keeps what `grpcurl`'s stderr used to give them.

### 5. Bash changes, all in `deploy/microvm/e11-density.sh`

- `EXEC_CLIENT="${SH_E11_EXEC_CLIENT:-grpcurl}"`, validated at startup beside
  `validate_arms` — an unrecognised value is refused rather than silently treated as one
  of the two.
- `build_exec_driver` compiles once from `main()` into `$RESULTS/.e11-exec-driver-bin`
  when the Go path is selected. `go` is already an unconditional `require_tool`, so
  preflight needs no new requirement. `grpcurl` also stays unconditional, because converge
  still uses it on every arm.
- `write_rung_plan` emits the plan before `wall_t0`.
- Phase 2 branches. The Go path runs one child and `wait`s on it; the `grpcurl` path keeps
  its `c`-subshell loop **verbatim**, because it is the reference the comparison is against.

### 6. Record schema

One added field:

- `execClient`: `grpcurl-per-exec` | `go-persistent-conn`.

Without it two ladders cannot be told apart. That is the same class of defect `c953c98`
fixed for stale rungs, one level up: a ladder that looks complete while mixing
measurements that were never comparable.

`drivingModel` stays `closed-loop-per-slot`. `proxyLimitations` gains an entry on the Go
path that replaces `driverControlChunkDecode`'s reasoning — the Go client decodes the same
events on every arm — and discloses the `ExecError` divergence from §"Additional finding".
`experiments/src/microvm-density.ts` takes the field as optional so the TS side
type-checks and an old record still parses.

### 7. One known bound, documented and not fixed

A single `ClientConn` multiplexes every slot's stream over one HTTP/2 connection. The
bound this creates is **not** a concurrent-stream cap: verified on the versions this repo
pins, neither server caps streams by default. `grpc.NewServer()` defaults
`maxConcurrentStreams` to `math.MaxUint32` (grpc-go v1.83.2 `server.go:189`), and
`@grpc/grpc-js` v1.14.4 passes `maxConcurrentStreams` to Node's http2 server only when
`grpc.max_concurrent_streams` is in its options (`server.js:176`), which the relay does not
set — Node then advertises `4294967295`.

The real bound is that one connection has one `loopyWriter` goroutine and one
connection-level flow-control window, so all `c` slots' framing serializes through a single
writer. That is a driver-side ceiling of exactly the kind this work exists to remove, one
layer down. It is not fixed here because nothing has measured it binding, and adding a
second connection now would put two changes into one comparison. If the Go client's
throughput plateaus while its `coresBusy` stays low, sharding slots across N connections is
the first thing to try — and `execClient` in the record is what makes that a distinguishable
third data point rather than a silent re-run.

## Testing

Go, in `remote-worker/cmd/exec-driver`:

- cause classification against every row of the table in §4, including order-sensitivity
  and the `unknown` fallthrough;
- plan validation refusals: empty mix, overlapping `reqBase` ranges, unwritable times
  file, missing target;
- a real drive against an in-test null responder, asserting per-slot line counts equal
  `iters + warmup`, the `<ms> <status> <cause>` format, issue order, and that the
  `req_id`s observed server-side are disjoint across slots.

Bash, in `deploy/microvm/tests/e11-density.test.sh`:

- the default is `grpcurl`, so opt-in is real rather than claimed;
- an unrecognised `SH_E11_EXEC_CLIENT` is refused;
- `write_rung_plan`'s output carries `slot_req_base`'s disjoint bases and the full mix;
- `execClient` reaches the record.

Seam closure, and the test that matters most: one case extracts the **real**
`write_rung_plan` from `e11-density.sh`, feeds its output to the **real** `exec-driver`
binary against a **real** `null-responder`, and asserts the times files. It needs no
`/proc`, no KVM and no cluster, so it runs everywhere the rest of the suite does.

### What cannot be verified here

`e11-density.sh` itself needs `/proc`, cgroups and a Linux host, so the seam is proven by
the test above rather than by a live sweep on the development machine. Both drivers are
run against the null-responder locally and the delta reported, but that number is
indicative only: it is a 10-core laptop, not the 72-core host that produced the table, and
it is not the comparison the acceptance criteria name.

## Documentation

- `deploy/microvm/EXPERIMENTS.md` §E11: how to select the Go client, and that §E11's
  conclusions stay marked under repair until the comparison runs on the host that produced
  the table.
- The runbook for the comparison: build both, `SH_E11_ARMS=driver-control` twice on one
  host with `SH_E11_EXEC_CLIENT` the only thing changed between them, at the published
  ladder's `ITERS_PER_SLOT=200` and `SAMPLE_INTERVAL_MS=250`, checking `hostCpuSamples`
  before quoting any CPU figure.

## Expected outcomes, stated in advance

Neither of these is a failure of this work:

1. **`coresBusy` and p95 fall materially at high `c`.** Then the published `c=8` knee was
   the driver's, and §E11's questions become worth asking again with the backend as the
   only remaining suspect.
2. **They do not fall.** Then the bottleneck is not `grpcurl`'s per-call cost, and that is
   itself the finding — it would point at the closed-loop model or at bash's own
   scheduling of `c` subshells, and it would say so with a control that has no backend.
