# Runbook: comparing E11's two Exec clients (issue #294)

The question is narrow: **how much of the `driver-control` arm's cost was `grpcurl`?** One
variable moves — `SH_E11_EXEC_CLIENT` — and everything else is held at the values that
produced the table in `EXPERIMENTS.md` §E11.

## The reference to beat

Bare metal, `srv-r16b14s16`, 72 cpu / 754 GiB, `virt: none`, governor `performance`, gawk.
`SH_E11_ARMS=driver-control`, `ITERS_PER_SLOT=200`, `SAMPLE_INTERVAL_MS=250`.

| c   | tput/s | p95    | hostCpuFraction | hostCpuFractionPeak | coresBusy /72 | hostCpuSamples |
| --- | ------ | ------ | --------------- | ------------------- | ------------- | -------------- |
| 1   | 56.8   | 17 ms  | 0.0204          | 0.0253              | 1.47          | 15             |
| 2   | 101.3  | 19 ms  | 0.0411          | 0.0470              | 2.96          | 17             |
| 4   | 171.6  | 25 ms  | 0.0879          | 0.1050              | 6.33          | 20             |
| 8   | 241.6  | 44 ms  | 0.2017          | 0.2131              | 14.52         | 25             |
| 16  | 219.6  | 137 ms | 0.4163          | 0.4864              | 29.97         | 46             |
| 32  | 204.9  | 340 ms | 0.7564          | 0.8069              | 54.46         | 72             |
| 64  | 231.6  | 753 ms | 0.8907          | 0.9598              | 64.13         | 103            |

The `p95` column above predates a post-review fix: both Exec clients now record `ms` to
three decimal places (from microseconds, integer-exact) instead of whole milliseconds,
because the Go client's per-Exec latency is sub-millisecond and whole-ms truncation
rounded it to `0` almost every time — so a new run's `p95Ms` will show three decimals
where this table shows a bare integer.

## Run both arms

Same host, same session, back to back. `SH_E11_RUN_ID` differs per invocation by default, and
`assemble_ladder` only collects rungs from the run that built the ladder, so the two ladders
cannot contaminate each other — but move the results aside between runs anyway, because the
filenames do not encode the client.

```bash
export SH_SUBSTRATE=metal
export SH_E11_ARMS=driver-control
export SH_E11_ACTIVE_RUNS="1 2 4 8 16 32 64"
export SH_E11_ITERS_PER_SLOT=200
export SH_E11_SAMPLE_INTERVAL_MS=250

SH_E11_EXEC_CLIENT=grpcurl bash deploy/microvm/e11-density.sh
mv deploy/microvm/.results deploy/microvm/.results-grpcurl

SH_E11_EXEC_CLIENT=go bash deploy/microvm/e11-density.sh
mv deploy/microvm/.results deploy/microvm/.results-go
```

## Before quoting any number

- **`hostCpuSamples` per rung, and the right knob to fix a low count.** A mean of one or
  two ticks cannot score a saturation verdict, and the driver warns at run time when a rung
  produced fewer than five. The reference run's 15–103 is healthy at these settings. A
  faster client finishes its window sooner, so the Go run's tick counts will be lower --
  but what has to change is **sampler cadence, not Exec count**: lower
  `SH_E11_SAMPLE_INTERVAL_MS`, `SH_E11_SAMPLE_MIN_TICK_MS` **and `SH_E11_SAMPLE_SLICE_MS`**
  until the Go run clears at least 10 ticks at the **same** `ITERS_PER_SLOT=200` the
  reference table used. `SAMPLE_SLICE_MS` matters and is easy to miss: `host_sampler_loop`
  computes `slices_per_tick` as `SAMPLE_INTERVAL_MS / SAMPLE_SLICE_MS` floored at 1, so once
  `SAMPLE_INTERVAL_MS` reaches `SAMPLE_SLICE_MS` (default 100 ms) lowering it further has no
  effect at all — the floor is `SAMPLE_SLICE_MS`, and 10 ticks inside a sub-200 ms window
  needs both of them well below 100 ms. Raising
  `ITERS_PER_SLOT` for the Go arm alone is wrong here: it moves the one variable this
  runbook exists to hold fixed (both arms must issue the same Exec count per slot to stay
  comparable), and it papers over a cadence problem with more work instead of a faster
  sampler.
- **Cranking cadence to reach 10 ticks can make the PSS walk the next artifact.**
  `SAMPLE_LOW_EVERY` (default 5) throttles the `pgrep` + `smaps_rollup` PSS walk relative
  to _tick rate_, not to wall-clock time — and tick 1 always samples PSS regardless of
  `SAMPLE_LOW_EVERY`. Pushing tick rate up to the ~70 Hz that 10 ticks inside a ~140 ms
  Go-arm window needs also pushes PSS/`pgrep` sampling to an absolute rate well past the
  ~1 Hz-ish envelope issue #291's fix was sized to avoid perturbing — on the very metric
  (`pssBytes`/Sigma PSS) spec section 7.3 cares most about getting right. The tradeoff is
  plain: chase 10 ticks via cadence and risk PSS sampling perturbing that rung, or hold
  cadence where #291 sized it and let the Go arm's tick count (and `hostCpuSamples`) run
  lower. **The alternative worth considering** is sizing both arms to a common wall-clock
  window instead of a common Exec count — matched Exec counts were a cleanliness choice
  for comparability, not a correctness requirement, since `p95`, throughput and
  `coresBusy` are each individually valid without them. That trade costs the "both arms
  issued identical Exec counts" property this runbook otherwise asks for. Which cost is
  acceptable is an operator call, not a rule this runbook sets.
- **If cadence alone still can't reach 10 ticks**, do not reach for `ITERS_PER_SLOT` as a
  second attempt. Run **two** Go ladders instead, each labelled by the setting that differs
  from the reference (for example "go, `SAMPLE_INTERVAL_MS=250`" and "go,
  `SAMPLE_INTERVAL_MS=<lower>`"), so a reader can tell which numbers came from which cadence
  and none are silently mixed with the `grpcurl` reference's settings.
- **Treat "the sampler cannot see the Go client's window" as a finding, not a nuisance to
  route around.** If even the fastest cadence this driver supports still can't resolve the
  Go arm's per-rung window at `c` values where `grpcurl` needed 250 ms ticks to see
  15–103 samples, that gap is itself evidence about how much faster the Go client is --
  record it in `EXPERIMENTS.md` §E11 beside the ladder, not as a footnote explaining away a
  thin row.
- **A rung with zero samples is refused, by name.** `run_density_rung` in
  `deploy/microvm/e11-density.sh` hard-refuses a rung that "produced ZERO host samples over
  its timed window" rather than backfilling from an idle post-load snapshot. Hitting that
  refusal on the Go arm is not a bug to route around -- it is the strongest form of the
  previous finding, and it means cadence has to come down further before this rung's number
  exists at all.
- **`execClient` in every record.** If it says `grpcurl-per-exec` in the `.results-go`
  directory, the env var did not take and the comparison is of one client with itself.
- **`SH_E11_COLD_LATENCY_MS`.** Irrelevant to this comparison's headline numbers but it feeds
  `coldAcquireRate`; on a host where the warm hot-path p50 is 240 ms the shipped 50 ms default
  classifies everything as cold. Derive it from E10 on the same host, as issue #291's
  shakedown did.
- **`SH_E11_VMM_PROC_PATTERN`.** Not used by this arm (no VMM), but scope it before any
  microvm run: the unscoped `firecracker` pattern matched another user's shell on the metal
  box, and under `sudo` a foreign process's PSS would be summed in.
- **Sequencing, before this comparison extends past `driver-control`.** The relay's
  `routeExec`-yields-`ExecEvent.error`-then-returns-OK defect (issue #295, and `EXPERIMENTS.md` §E11)
  makes zero difference here: the null-responder only ever sends `End`, so on
  `driver-control` the two clients are identical by construction and there is nothing for
  that defect to touch. It is not zero difference on `container`/`microvm` -- fix the relay
  first, before running either client against a real backend, or a `grpcurl`-vs-`go` delta
  on those arms could be confounded with a change in what one client silently miscounts as
  `ok`.

## What the result means

- **`coresBusy` and p95 fall materially at high `c`.** The published `c=8` knee was the
  driver's. §E11's questions become worth asking again, with the backend as the only remaining
  suspect, and a three-arm sweep is worth booking.
- **They do not fall.** `grpcurl`'s per-call cost was not the bottleneck, and that is the
  finding. It points at the closed-loop model — `drivingModel` is still
  `closed-loop-per-slot`, with a declared coordinated-omission bias that understates latency
  at saturation — or at bash's scheduling of `c` subshells, and it says so with a control that
  has no backend.

Either way, record the result in `EXPERIMENTS.md` §E11 and close #294 with the numbers, not
with the code landing.

## One bound worth knowing

The Go client uses **one** connection for a whole rung. Neither server caps concurrent
streams on the pinned versions (grpc-go defaults `maxConcurrentStreams` to `math.MaxUint32`;
`@grpc/grpc-js` leaves Node's http2 default of `4294967295`), so a stream cap is not the
limit. The limit is that one connection has one `loopyWriter` goroutine and one
connection-level flow-control window, so every slot's framing serializes through one writer.
If throughput plateaus while `coresBusy` stays low, shard slots across N connections and run a
third arm — `execClient` is what keeps the three distinguishable.

## Local indicative measurement (not the acceptance comparison)

This machine — a 10-core macOS laptop, no `/proc`, no cgroups — cannot run
`deploy/microvm/e11-density.sh` at all, let alone reproduce the 72-core rig above. What follows
is a smaller, direct comparison of the two Exec clients against the null-responder, run once
during Task 9 of this plan, to prove both clients work and to get a first-order signal before
booking rig time. **It is indicative only and is not the 72-core comparison issue #294's
acceptance criteria name.** No host-CPU measurement was taken, `mix` was reduced to the single
command `true`, and there is no `hostCpuFraction`, `coresBusy` or `hostCpuSamples` in what
follows — only wall-clock Exec throughput.

### Calibrating the Go arm, then abandoning that count

The Go arm was calibrated upward first, to find an `itersPerSlot` whose wall time escapes
process-startup noise: 200 Execs against the Go client here complete in well under 200 ms,
which is dominated by process and connection startup and shows nothing. Raising `itersPerSlot`
on the `c=1` case (the slowest per-slot rate, since it has the least concurrency to amortize
dial and goroutine setup) until it cleared roughly 2 seconds of wall time landed on 18000: 15000
measured 1.821 s, 16000 measured 1.894 s, 17000 measured 2.099 s, 18000 measured 2.169 s.

That count — 18000 plus `warmupPerSlot=3`, i.e. 18003 Execs per slot — was then **abandoned**
for the paired run below, because the constraint that both arms issue identical Exec counts
makes `grpcurl`, not `go`, the binding cost. At the `grpcurl` rate this run measured (38.4
Exec/s at c=1, see the table below), 18003 Execs in a single `c=1` slot would need roughly 470
seconds (18003 / 38.4 ≈ 468.8 s) — well beyond any reasonable per-rung cap, and that is before
`c=4` and `c=8` are even considered.

This is itself a finding, not a workaround: the reference driver cannot deliver in minutes what
the Go client delivers in about a second, and the four calibration numbers above quantify that
gap directly.

### The paired run

Both arms instead issued **2000 Execs per slot on both arms** at every concurrency, against a
single `null-responder` on loopback — scaled up from the brief's illustrative
`itersPerSlot=200`, and far below the abandoned 18000 above, so that `grpcurl` could complete
within a reasonable per-rung cap while both clients still issued identical, comparable counts.
The per-rung cap was 280 s; no rung hit it, and all rungs exited 0. Times-file line counts were
verified at 2000 / 8000 / 16000, matching the Exec counts exactly at c=1/4/8.

| c   | grpcurl Exec/s | go Exec/s | go faster by | grpcurl wall | go wall |
| --- | -------------- | --------- | ------------ | ------------ | ------- |
| 1   | 38.4           | 2133.6    | 55.6x        | 52.04s       | 0.94s   |
| 4   | 183.9          | 11289.9   | 61.4x        | 43.51s       | 0.71s   |
| 8   | 286.5          | 13975.7   | 48.8x        | 55.85s       | 1.14s   |

The Go client is roughly 49x to 61x faster per Exec than `grpcurl` on this machine, depending on
concurrency (55.6x at c=1, 61.4x at c=4, 48.8x at c=8). That gap is expected and is not a
substitute for the rig comparison: the null-responder here answers over loopback with no relay,
no proto re-parse cost paid by anything but `grpcurl` itself, and no contention from 72 cores'
worth of other work. It shows only that the mechanical difference the brief predicts — one
persistent connection versus one `execve` and one fresh HTTP/2 session per Exec — is real and
large on this host. Whether it is what moved the published `c=8` knee on the 72-core rig is
exactly the open question this runbook's rig procedure, above, is for.

Two caveats on reading this table: the Go arm's low-`c` figure is somewhat understated because
its process start and single dial are inside its measured wall time; and no concurrency was
repeated (n=1), so single-trial shapes should not be read as evidence of a specific mechanism.
In particular, the non-monotonic dip at `c=4` (0.71s, faster wall time than `c=1`'s 0.94s)
appears in **both** arms — `grpcurl` shows the same shape, 52.04s → 43.51s → 55.85s at
c=1/4/8 — and `grpcurl` opens a fresh connection for every call, so it has no single fixed dial
that could produce that pattern. A mechanism that cannot exist in an arm exhibiting the same
pattern does not explain that pattern; the more parsimonious reading is concurrency amortizing
serial per-call latency on a lightly loaded machine, or plain noise from a single trial.
