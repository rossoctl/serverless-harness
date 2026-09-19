#!/usr/bin/env bash
# deploy/microvm/e11-density.sh
#
# E11 — density and the replenishment ceiling (spec section 7.3). Unlike E10 (Task
# 20), this drives THROUGH THE RELAY against a real worker binary, sweeping
# concurrent active runs x D x GuestRAMBytes, so it is a concurrency sweep, not a
# ladder of isolated terms.
#
# SCOPE (pre-run hardware correction F1; a build-time note, not committed): this task builds the INSTRUMENT and
# runs it, once, on a shared nested rig to validate the mechanism -- not to produce
# the headline density number. This script is written to be run on that rig by a
# human operator; it is NOT invoked by any automated test in this repo, and nothing
# in deploy/microvm/tests/e11-density.test.sh calls main(). See the scope note in the header
# for the full disclosure of every proxy/limitation below.
#
# Three arms by default (hardware-corrections F5, extended by issue #291 item 3):
# "container" (today's remote-worker, no microVM at all -- the baseline E11 is
# priced against), "microvm" (microvm-worker, Firecracker ONLY), and
# "driver-control" (a null-responder standing in for a backend, see
# start_null_stack below -- it measures the driver's own cost, not either real
# backend). Cloud Hypervisor is not one of the three: on this project's rig it
# dies during device restoration after logging
# "Restoring virtio-console __console", with no error propagated through its API,
# and presents as a 30-second hang -- it does not restore, so there is nothing to
# sweep. Where a CH column would appear in a write-up, that absence is the reason,
# not "it was slower" (F5).
#
# Because the microvm arm is Firecracker-only, and spec section 4.3's Firecracker
# cross-cut is "+ block with mount-at-acquire" (not virtio-fs), a correctly-running
# sweep on this arm has ZERO virtiofsd processes -- virtiofsd is a Cloud Hypervisor
# thing. pss_bytes_for_pids summing 0 bytes for the virtiofsd pattern here is
# therefore the EXPECTED result of an absent process, not evidence of a bug in the
# sampler. See discover_pids / host_signals_snapshot below.
#
# Spec section 7.5 traps, and how each is handled here:
#   - closed-loop driver hides queueing:  NOT eliminated. run_density_rung drives
#     each of the c concurrent "slots" as a tight loop that waits for one Exec to
#     finish before issuing the next (closed-loop, per slot) rather than a genuine
#     open-loop / rate-based arrival process. Spec section 7.5 permits either
#     ("drive open-loop / rate-based, or declare the bias") -- this script takes the
#     declared-bias branch. drivingModel="closed-loop-per-slot" is written into
#     every rung's JSON record for exactly this reason: coordinated omission means
#     this design UNDERSTATES latency at saturation, which is the regime
#     prediction 3 (cold-acquire shape) lives in. A future revision that swaps this
#     for a real rate-based driver would only need to change how requests are
#     scheduled onto the same grpc_exec_record() plumbing.
#   - page-cache asymmetry between arms: drop_caches (dup of e10-lifecycle.sh's own
#     function) runs between every pair of arms in the shuffled order (not just
#     container/microvm -- driver-control gets the same treatment), and
#     shuffle_e11_arms randomizes which arm goes first, exactly as E10 does for its
#     own arms.
#   - guest-side timing is garbage: every timestamp in this script is taken on the
#     HOST, never a guest clock. Per-Exec latency (grpc_exec_record) is now
#     $EPOCHREALTIME read before/after the grpcurl call, with no subprocess fork
#     in the timed path (issue #291 item 1); each rung's own wall time
#     (wall_t0/wall_t1) still comes from date +%s%N.
#   - CPU frequency / thermal drift: check_governor (dup of e10-lifecycle.sh's own
#     function) still refuses a non-"performance" governor before any rung runs.
#   - converge hides inside the rungs (section 4.5): converge_slot times ONE
#     Exec running the exact converge script harness/src/converge.ts:
#     buildConvergeScript() builds (reproduced here verbatim, see build_converge_
#     script below) BEFORE a slot's timed Exec-mix loop starts, and its wall time
#     is recorded in a SEPARATE field (convergeMsP50) from the Exec-mix p50/p95, so
#     a slow fetch cannot misread as a throughput ceiling.
#
# Section 4.5's owed decision (hardware-corrections F7: DO NOT decide it here). The
# spec's own three shapes, verbatim:
#   1. "Two mounts." A host-shared /workspace/repo (read-mostly) plus a per-run rw
#      dir for worktrees. Cheapest to reason about; needs the fetch lock to become
#      host-level rather than per-pod.
#   2. "Per-run clone with --shared / alternates" against a host-side object store.
#   3. "Accept the cold fetch" and pre-seed the golden snapshot's workspace image
#      with the repos in play -- viable for the experiment, not for a general
#      deployment.
# SH_E11_REPO_CACHE_SHAPE below RECORDS which one a run claims (spec section 7.5:
# "record which of section 4.5's three shapes the run used") -- it does NOT decide
# among them. Its default, "accept-cold-fetch" (shape 3), is chosen here only
# because it is the one this script can drive with no new mount/clone
# infrastructure on the Firecracker+block arm (there is no host<->guest shared
# filesystem to put a "two mounts" or "--shared" object store on without inventing
# one) -- a narrower, disclosed choice about how THIS INSTRUMENT feeds workload, not
# a recommendation about what production should adopt. An operator who wants to
# validate shape 1 or 2 must point SH_E11_CONVERGE_REPO_URL at infrastructure they
# built themselves; this script does not implement the other two shapes.
#
# The four second-order settings held at their spec section 4.1 defaults and
# RECORDED, NOT SWEPT (spec section 7.3: "adding four dimensions to
# runs x D x GuestRAMBytes would multiply the rung count for a term the memory
# arithmetic already bounds"). These match remote-worker/internal/vmpool/config.go's
# own DefaultStandbyIdle / DefaultWorkspaceIdle / DefaultReplenishDelay constants and
# that file's own anchor comment ("E11 holds StandbyIdle, WorkspaceIdle,
# ReplenishDelay and ReclaimScanInterval at these values and RECORDS them rather
# than sweeping them"). None of the four has an env override in microvm-worker's
# poolConfig() -- there is nothing to sweep even if this script wanted to:
#   - StandbyIdle        = 90s   (config.go DefaultStandbyIdle)
#   - WorkspaceIdle       = 1800s (config.go DefaultWorkspaceIdle, 30m)
#   - ReplenishDelay      = 0.2s  (config.go DefaultReplenishDelay, 200ms)
#   - ReclaimScanInterval = 22.5s (StandbyIdle/4, per spec section 7.3's own framing)
#
# Disclosed proxies and limitations (the full write-up is a build-time note, not committed;
# summarized here at the point each is produced, not hidden in a report nobody
# reads before running this):
#   - leaseSaturations is ALWAYS 0. This driver issues Execs directly against the
#     relay/worker over grpcurl and never goes through harness/src/sandbox-lease.ts
#     or KAGENTI_SANDBOX_CAP, so it structurally cannot exercise or observe the
#     harness-side lease cap spec section 7.3's last metric row asks for. A rung
#     that would have saturated a lease in the real harness path is invisible here.
#   - coldAcquireRate is a LATENCY-CLASSIFICATION PROXY, not the real replenishment
#     signal: microvm-worker exposes no stats/introspection endpoint (confirmed:
#     none exists in cmd/microvm-worker/main.go), and adding one is a Go change out
#     of this task's deliverables. An Exec is counted as "cold" if its host-side
#     latency is >= SH_E11_COLD_LATENCY_MS. execErrorsByCause is real (derived from
#     the Exec RPC's own error/ExecError signal), coldAcquireRate is not.
#   - standbysResident is a PROXY: max(processCount - c, 0), not a real pool-side
#     count (same missing-introspection reason as above).
#   - The model stub P6 section 5.4 specifies (deploy/knative/model-stub/) does not
#     exist in this worktree/branch (confirmed via `ls`: only present on the
#     unmerged feat/p6-experiments branch). SH_E11_MODEL_STUB_CMD lets an operator
#     point at it once it exists; absent that, this script drives the Exec mix
#     itself at a fixed, declared rate rather than the model stub's calibrated
#     tool-call rate -- another reason drivingModel is recorded, not assumed.
#
# Usage (never run by this task -- the instrument is built, not executed):
#   SH_SUBSTRATE=nested-m8i \
#   SH_SNAPSHOT_DIR=/srv/snapshots SH_WORKSPACE_ROOT=/srv/workspaces \
#   SH_MAX_COMMITTED_MB=8192 \
#     bash deploy/microvm/e11-density.sh
set -uo pipefail

# LC_ALL is pinned for the WHOLE driver, and exported so awk, python3 and grpcurl inherit
# it. $EPOCHREALTIME -- which replaces two `date +%s%N` forks per Exec below -- renders with
# the LOCALE's decimal separator, so under e.g. LC_NUMERIC=de_DE it yields
# "1789672470,123935". epoch_delta_ms strips a '.', not a ',', so the comma would survive
# into `10#`, and every Exec's latency would become an arithmetic error INSIDE the timed
# loop. require_epochrealtime in preflight proves the pin took.
LC_ALL=C
export LC_ALL

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
# ABSOLUTE, always, because two callers `cd` elsewhere before using it: both
# `go build -o "$RESULTS/..."` calls run inside `(cd "$REMOTE_WORKER_DIR" && ...)`. With a
# relative RESULTS they wrote the worker binaries to
# remote-worker/deploy/microvm/.results/, a directory that does not exist, the build
# failed, its exit status was unchecked, and the first symptom was a converge failure
# naming neither the build nor the path. Found on E11's first-ever execution. The test
# suite could not see it: it overrides RESULTS with an absolute /tmp path.
#
# A relative override is normalised rather than rejected, so `RESULTS=out ./e11-density.sh`
# keeps working and means what it looks like.
RESULTS="${RESULTS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/deploy/microvm/.results}"
case "$RESULTS" in /*) ;; *) RESULTS="$PWD/$RESULTS" ;; esac

# Required, no default -- same reasoning e10-lifecycle.sh gives for SH_SUBSTRATE:
# an explicit, operator-set label cannot silently mislabel a nested run as metal
# (hardware-corrections F3: this rig is nested-m8i, an EC2 m8i.xlarge, NOT
# nested-c8i -- never pass SH_SUBSTRATE=metal on this box).
SUBSTRATE="${SH_SUBSTRATE:?set SH_SUBSTRATE (e.g. nested-m8i per hardware-corrections F3) - spec section 6 requires the substrate in every run record}"
SNAPSHOT_DIR="${SH_SNAPSHOT_DIR:?set SH_SNAPSHOT_DIR - the same env var name microvm-worker requires, see cmd/microvm-worker/main.go}"
WORKSPACE_ROOT="${SH_WORKSPACE_ROOT:?set SH_WORKSPACE_ROOT - the same env var name microvm-worker requires, see cmd/microvm-worker/main.go}"
# microvm-worker's own required var (poolConfig(): "SH_MAX_COMMITTED_MB is required:
# without the memory gate, ..."); this script requires it too and passes it straight
# through, rather than inventing a separate density-sweep memory budget.
MAX_COMMITTED_MB="${SH_MAX_COMMITTED_MB:?set SH_MAX_COMMITTED_MB - the same required env var microvm-worker refuses to start without}"

GOVERNOR_PATH="${GOVERNOR_PATH:-/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor}"
PROC_ROOT="${SH_E11_PROC_ROOT:-/proc}" # overridable so tests can fake smaps_rollup without a Linux /proc

# Sweep dimensions (spec section 7.3: "Sweep concurrent active runs x D x
# GuestRAMBytes"). Defaults are vmpool's own single-point defaults
# (DefaultStandbyDepth=2, DefaultGuestRAMBytes=256MiB); the active-runs ladder
# MUST include c=1 -- detectKnee (experiments/src/sharing.ts) throws without a
# c===1 baseline point, and analyzeLadder relies on that, so this is validated
# below rather than discovered two hours into a sweep.
read -r -a D_VALUES <<<"${SH_E11_D_VALUES:-2}"
read -r -a RAM_MB_VALUES <<<"${SH_E11_GUEST_RAM_MB_VALUES:-256}"
read -r -a ACTIVE_RUNS <<<"${SH_E11_ACTIVE_RUNS:-1 2 4 8}"

# The arms driven, in randomized order (shuffle_e11_arms). "driver-control" is ON BY DEFAULT
# (issue #291 section 4): it drives the identical run_density_rung against
# remote-worker/cmd/null-responder -- one End per Exec, no relay, no Redis, no worker, no VMM
# -- so subtracting it at each c gives the DRIVER's own contribution to observed latency. The
# control whose absence let a driver artifact be published as a density finding should not be
# opt-in. Set SH_E11_ARMS to opt out.
read -r -a E11_ARMS <<<"${SH_E11_ARMS-container microvm driver-control}"
# The null-responder's loopback port. Deliberately NOT E11_RELAY_PORT: the control arm's
# "stack" is one process and never coexists with a relay, but sharing the port would make a
# stale relay from a previous arm answer the control arm's Execs, which is the one thing this
# arm must never measure.
NULL_RESPONDER_PORT="${SH_E11_NULL_RESPONDER_PORT:-8445}"

# SIZE THIS SO EVERY WINDOW SPANS AT LEAST ~10 SAMPLER TICKS. The default of 20 is a floor for
# the SLOW arms, not a recommendation for the fast ones: measured on the nested-m8i rig during
# issue #291's shakedown, the container and driver-control arms sustain 75-256 Exec/sec, so a
# 23-Exec slot closes its window in well under one 1 Hz tick and the rung records hostCpuSamples=1
# with hostCpuFractionPeak == hostCpuFraction. A one-sample mean is not a number to score
# crosses('cpu')'s >= 0.9 against. The microvm arm needs no adjustment (it ran 25 samples at this
# default, being ~15x slower per Exec). Raise this, or lower SH_E11_SAMPLE_INTERVAL_MS, and check
# hostCpuSamples in the records before quoting any CPU figure.
ITERS_PER_SLOT="${SH_E11_ITERS_PER_SLOT:-20}"
WARMUP_PER_SLOT="${SH_E11_WARMUP_PER_SLOT:-3}"

# Section 4.5's owed shape, RECORDED not decided (hardware-corrections F7). See the
# header comment above for the exact three verbatim shape names this must be one of.
REPO_CACHE_SHAPE="${SH_E11_REPO_CACHE_SHAPE:-accept-cold-fetch}"
CONVERGE_REPO_URL="${SH_E11_CONVERGE_REPO_URL:-file:///workspace/seed-repo}"
CONVERGE_REF="${SH_E11_CONVERGE_REF:-HEAD}"

# Optional: point at a real P6 section 5.4 model stub once one exists in this repo.
# Absent, this script drives the Exec mix itself (see header comment's disclosure).
MODEL_STUB_CMD="${SH_E11_MODEL_STUB_CMD:-}"

# Disclosed latency-classification proxy threshold for coldAcquireRate (see header).
COLD_LATENCY_MS="${SH_E11_COLD_LATENCY_MS:-50}"

# VMM / virtiofsd host process patterns for PSS sampling (spec section 7.3: "Sigma
# PSS across VMM + virtiofsd"). Overridable so a test can point these at a fake
# marker process rather than a real firecracker/virtiofsd binary.
VMM_PROC_PATTERN="${SH_E11_VMM_PROC_PATTERN:-firecracker}"
VIRTIOFSD_PROC_PATTERN="${SH_E11_VIRTIOFSD_PROC_PATTERN:-virtiofsd}"

# In-rung host sampling (issue #291 item 1). The sampler brackets exactly the timed Exec
# window; see host_sampler_loop for why there are two cadences and what each costs.
#
# 1 Hz by default: the every-tick path is builtins only, so its cost is a `sleep` fork per
# slice and nothing else. SAMPLE_SLICE_MS is how often the loop checks the stop file.
#
# The final tick at stop is taken ONLY when no full tick has already landed for this rung
# (host_sampler_loop gates it on SAMPLE_TICK == 0). A rung that already has one or more real
# ticks never gets an extra one at stop: that tick's window would be mostly post-window idle
# time averaged in with equal weight to the real ticks, biasing the mean toward "the driver
# was idle" -- the same failure mode issue #291 exists to fix, at reduced magnitude. When no
# full tick has landed (a rung shorter than SAMPLE_INTERVAL_MS), the final tick is still taken
# once SAMPLE_MIN_TICK_MS has elapsed, so a short rung gets exactly one sample rather than
# none.
SAMPLE_INTERVAL_MS="${SH_E11_SAMPLE_INTERVAL_MS:-1000}"
SAMPLE_SLICE_MS="${SH_E11_SAMPLE_SLICE_MS:-100}"
# The floor under the final tick at stop (see above -- only reachable when zero full ticks
# have landed). A /proc/stat diff over a few milliseconds is jiffy noise, not a measurement,
# so below this the stop tick records NOTHING and the rung's hostCpuSamples is 0 -- which
# run_density_rung refuses, naming the fix.
SAMPLE_MIN_TICK_MS="${SH_E11_SAMPLE_MIN_TICK_MS:-200}"
# pssBytes and processCount need pgrep plus an N-file smaps_rollup walk, so they run every
# Nth tick (and always on tick 1, so a rung with CPU samples can never have zero of them).
# Defensible because crosses('memory') in experiments/src/microvm-density.ts reads
# memAvailableBytes -- which IS every tick -- not pssBytes: PSS feeds the narrative, not the
# bound classification. The cadence is recorded in every rung's proxyLimitations, and each
# signal's own sample count is written to the record.
SAMPLE_LOW_EVERY="${SH_E11_SAMPLE_LOW_EVERY:-5}"

# Sampler state. At script scope, above first use, because `shellcheck -o
# check-unassigned-uppercase` is a gate here (a variable referenced but never assigned
# passes plain shellcheck AND `bash -n`, and is a hard failure under this driver's `set -u`
# on the first line that reads it -- exactly how $PROTO_IMPORT_PATH shipped undefined).
SAMPLE_IDLE=0
SAMPLE_TOTAL=0
SAMPLE_MEM_AVAILABLE_BYTES=0
SAMPLE_PREV_IDLE=0
SAMPLE_PREV_TOTAL=0
SAMPLE_TICK=0

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REMOTE_WORKER_DIR="$REPO_ROOT/remote-worker"
EXPERIMENTS_DIR="$REPO_ROOT/experiments"
PROTO_FILE="$REPO_ROOT/proto/sandbox/v1/sandbox.proto"
# grpcurl REFUSES an absolute -proto path unless it is also given at least one
# -import-path ("must specify at least one import path if any absolute file paths are
# given"), and it fails at proto-parsing time — before it dials anything. So every RPC
# this driver makes failed, in both arms, on any host: E11 could not measure a single
# Exec. Found on its first-ever execution; it would have failed identically on metal.
# The pair below is the form verified against the real grpcurl on the rig: import path at
# the proto ROOT, file named relative to it. PROTO_FILE is kept for the existence check,
# which is about the file being there rather than about how grpcurl is invoked.
# Client-side deadlines for grpcurl, a margin above each request's own timeout_s. Without
# them a wedged Exec hangs the WHOLE ladder rather than failing one rung: an Exec that
# collided on req_id (see run_density_rung) left grpcurl waiting 33 MINUTES on the
# validation rig, and the request's own timeout_s never fired because nothing server-side
# was late -- the response simply went to the other caller. Verified against that exact
# wedge on the rig: -max-time returns non-zero at the deadline where the call otherwise
# hung indefinitely, so it covers an established-stream stall and not merely a dial
# failure.
EXEC_MAX_TIME_S="${SH_E11_EXEC_MAX_TIME_S:-45}"      # guards timeout_s:30
CONVERGE_MAX_TIME_S="${SH_E11_CONVERGE_MAX_TIME_S:-360}" # guards timeout_s:300

# SH_E11_EXEC_CLIENT selects WHICH CLIENT issues the timed Execs (issue #294).
#
#   grpcurl - one grpcurl process per Exec. The reference path, and the default.
#   go      - remote-worker/cmd/exec-driver: one process and ONE grpc.ClientConn for a whole
#             rung, c goroutines in place of c subshells.
#
# Why this is opt-in rather than a replacement: measured on metal with the driver-control arm
# (no relay, no Redis, no worker, no VMM), the grpcurl driver ALONE peaked at c=8 and then
# declined, burning 64 of 72 cores at c=64 with its own p95 of 753ms -- the same knee position
# and curve shape EXPERIMENTS.md published for both real arms. (That 753ms is PR #293's
# repaired driver at ITERS_PER_SLOT=200; EXPERIMENTS.md's own published 1686ms is the pre-#291
# driver at ITERS_PER_SLOT=20 -- different drivers at different counts, a mismatch that runs
# in this finding's favor, not against it.) The Go client exists to remove that, but the
# number that proves it must come from running BOTH against the null-responder on one host
# with nothing else changed. Until that comparison exists, the bash path is the reference and
# stays the default.
EXEC_CLIENT="${SH_E11_EXEC_CLIENT:-grpcurl}"
# Built once per run by build_exec_driver, beside the null-responder's binary.
E11_EXEC_DRIVER_BIN="$RESULTS/.e11-exec-driver-bin"
PROTO_IMPORT_PATH="$REPO_ROOT/proto"
PROTO_REL_PATH="sandbox/v1/sandbox.proto"

# Shared relay/redis stack knobs -- only ONE arm's stack is ever up at a time (each
# arm is fully torn down before the next starts), so both arms reuse the same ports.
E11_REDIS_PORT="${SH_E11_REDIS_PORT:-6381}"
E11_RELAY_PORT="${SH_E11_RELAY_PORT:-8444}"
E11_RELAY_TOKEN="${SH_E11_RELAY_TOKEN:-e11-dev-token}"
E11_START_STACK="${SH_E11_START_STACK:-1}"

# The redis image, overridable so an operator can PIN A DIGEST
# (SH_E11_REDIS_IMAGE=redis@sha256:...) for a reproducible run. `redis:7` is a floating
# tag; it stays the default because it is what the rest of this repo already pulls, and
# because a digest this script has never pulled would be a guess, not a pin.
E11_REDIS_IMAGE="${SH_E11_REDIS_IMAGE:-redis:7}"

# A per-invocation identity, stamped into every rung record and enforced by assemble_ladder.
# WHY: $RESULTS accumulates across runs and nothing clears it -- not this script, not the metal
# runbook. assemble_ladder used to glob `e11-rung-<arm>-c*.json`, so a rung left over from an
# EARLIER run with different settings was silently assembled into the current ladder. Observed
# during issue #291's shakedown: a c=2 rung from a 20-iter smoke reappeared inside a 600-iter
# ladder, carrying that run's one-sample hostCpuFraction. detectKnee anchors on the c=1 baseline,
# so a stale c=1 does not merely add a bad point -- it re-scales every health decision after it.
# That is this issue's own failure mode one level up: a ladder that looks complete while mixing
# measurements that were never comparable.
E11_RUN_ID="${SH_E11_RUN_ID:-$(date +%Y%m%dT%H%M%S)-$$}"

die() { echo "e11: $*" >&2; exit 1; }
log() { echo "e11: $*" >&2; }

# ---------------------------------------------------------------------------
# Teardown, armed BEFORE anything is started (review 4001908613).
#
# This driver had no `trap` at all, so every `die` path -- host_signals_snapshot's two
# refusals, the record guard, a failed percentile -- left the whole arm's stack running:
# the worker, the relay, the redis container, and the per-rung temp dirs. Beyond the
# leak, the orphans actively corrupt the next attempt:
#   - the orphaned relay/worker keep 8444/6381 bound, so the operator's rerun fails at
#     relay start with a bind error that says nothing about the real cause;
#   - an orphaned `firecracker` is still matched by discover_pids' UNSCOPED
#     `pgrep -f firecracker`, so it silently inflates the NEXT run's pssBytes -- the one
#     number spec section 7.3 insists must not be wrong, corrupted in a way that looks
#     like a real density result.
#
# Ordering and variable discipline both follow build-snapshot.sh's cleanup_on_exit
# (which documents the bug at length): kill before remove, and nothing this trap touches
# is ever a function local. That is why the pid globals and the temp root are declared
# HERE, above the trap, rather than further down next to the functions that assign them:
# a failure anywhere after this point finds them defined, and `${VAR:-}` defaults keep a
# future global added without one from reintroducing the "unbound variable INSIDE the
# trap, which aborts the rest of the trap" failure.
#
# Every temp path this script creates now lives under $E11_TMPDIR (rather than bare
# `mktemp`/`mktemp -d` calls held in function locals), so one `rm -rf` here reclaims all
# of them however deep the sweep was when it stopped.
# ---------------------------------------------------------------------------
E11_WORKER_PID=""
E11_RELAY_PID=""
E11_WORKER_BIN=""
E11_SAMPLER_PID=""
E11_NULL_PID=""
E11_NULL_BIN=""
E11_TMPDIR="$(mktemp -d "${TMPDIR:-/tmp}/e11-density.XXXXXX")"

cleanup_on_exit() {
  # Set BEFORE either stop_*_stack call so kill_relay_by_port can tell a trap-driven,
  # best-effort teardown (log and move on) from a between-arm one (die - see
  # kill_relay_by_port's own comment): die is a bare `exit 1`, which the `|| true`
  # below cannot catch, so without this flag a stuck relay from stop_container_stack
  # would abort the trap before stop_microvm_stack or the E11_TMPDIR cleanup ever ran.
  E11_IN_CLEANUP=1
  # The sampler goes before the stacks and, crucially, before the `rm -rf "$E11_TMPDIR"`
  # below: host_sampler_loop polls for a stop file under that root, so once the root is gone
  # the file can never appear and the subshell would spin forever appending to a deleted path.
  stop_host_sampler || true
  stop_container_stack || true
  stop_microvm_stack || true
  stop_null_stack || true
  [ -z "${E11_TMPDIR:-}" ] || rm -rf "$E11_TMPDIR"
}
trap cleanup_on_exit EXIT

# ---------------------------------------------------------------------------
# Preflight -- duplicated from e10-lifecycle.sh's own check_kvm/check_cgroups/
# check_swap/check_governor rather than sourcing that file: sourcing a sibling
# script that ends in its own unconditional main() call is a fragile cross-script
# dependency for four ~5-line functions. Kept byte-for-byte equivalent in behavior
# (not merely in intent) so e11-density.test.sh can extract and test them exactly
# as e10-lifecycle.test.sh does.
# ---------------------------------------------------------------------------
check_kvm() {
  [ -e /dev/kvm ] || die "no /dev/kvm"
}

check_cgroups() {
  local t
  t="$(stat -fc %T /sys/fs/cgroup 2>/dev/null || echo unknown)"
  [ "$t" = cgroup2fs ] ||
    die "cgroups v1: spec section 2.4 records it as a cause of high restore latency, so a rung measured here is not comparable"
}

check_swap() {
  [ -z "$(swapon --show 2>/dev/null)" ] ||
    die "swap is on: swapping guest RAM destroys the latency this design exists for (spec section 2.4)"
}

check_governor() {
  if [ ! -e "$GOVERNOR_PATH" ]; then
    echo "not exposed"
    return 0
  fi
  local g
  g="$(cat "$GOVERNOR_PATH" 2>/dev/null || echo "")"
  if [ "$g" != "performance" ]; then
    die "governor is '$g', not performance: replenishment is a CPU burst (spec section 7.5). This is fixable - set it and rerun."
  fi
  echo "performance"
}

# validate_repo_cache_shape refuses an SH_E11_REPO_CACHE_SHAPE value that is not one
# of spec section 4.5's three named shapes -- recording an invented fourth shape
# would be worse than recording none.
validate_repo_cache_shape() {
  case "$REPO_CACHE_SHAPE" in
  two-mounts | shared-clone | accept-cold-fetch) : ;;
  *)
    die "SH_E11_REPO_CACHE_SHAPE='$REPO_CACHE_SHAPE' is not one of the spec section 4.5 shapes: two-mounts (shape 1, 'Two mounts.'), shared-clone (shape 2, 'Per-run clone with --shared / alternates'), accept-cold-fetch (shape 3, 'Accept the cold fetch')"
    ;;
  esac
}

# validate_arms refuses an SH_E11_ARMS value that is not one of the three arms this driver
# implements, and refuses an empty list. An invented arm would otherwise fall through main()'s
# case with no branch, so the sweep would "succeed" having driven nothing -- which is the
# looks-like-success failure mode this file spends most of its refusals on. A Cloud
# Hypervisor spelling in particular is a plausible typo and is NOT an arm here (see the
# header for why: on this rig CH does not restore).
validate_arms() {
  [ "${#E11_ARMS[@]}" -gt 0 ] ||
    die "SH_E11_ARMS is empty - a sweep with no arms would complete having measured nothing. The three arms are: container, microvm, driver-control."
  local arm
  for arm in "${E11_ARMS[@]}"; do
    case "$arm" in
    container | microvm | driver-control) : ;;
    *)
      die "SH_E11_ARMS contains '$arm', which is not one of this driver's three arms: container (today's remote-worker, the baseline), microvm (microvm-worker, Firecracker only), driver-control (the null-responder, issue #291 section 4). Cloud Hypervisor is not an arm here - see this file's header."
      ;;
    esac
  done
}

# validate_exec_client refuses any SH_E11_EXEC_CLIENT that is not one of the two real paths.
# A typo must not fall through to a default: the value is stamped into every rung record as
# execClient, and a ladder recorded under the wrong one would be compared against the wrong
# table -- the same class of defect as a stale rung assembled into a fresh ladder.
validate_exec_client() {
  case "$EXEC_CLIENT" in
  grpcurl | go) : ;;
  *)
    die "SH_E11_EXEC_CLIENT is '$EXEC_CLIENT', which is neither 'grpcurl' (one process per Exec, the reference path, the default) nor 'go' (remote-worker/cmd/exec-driver, one persistent connection per rung -- issue #294). Refusing to guess which was meant: the value is recorded as execClient in every rung, so guessing wrong mislabels a whole ladder."
    ;;
  esac
}

# exec_client_label prints the value stamped into each rung record as execClient. The record's
# vocabulary is deliberately MORE descriptive than the env var's: "grpcurl" says which tool, and
# "grpcurl-per-exec" says the thing that matters about it, which is one process per call.
# Pure function of EXEC_CLIENT so the suite can drive both branches in isolation.
exec_client_label() {
  case "$EXEC_CLIENT" in
  go) printf 'go-persistent-conn' ;;
  *) printf 'grpcurl-per-exec' ;;
  esac
}

# driver_control_note_for and exec_error_note_for print the two proxyLimitations disclosures whose
# text DEPENDS on which client ran. Pure functions of their argument, like exec_client_label above,
# so the suite can drive both paths in isolation -- the branch that chose between these strings used
# to live inline in run_density_rung, where no test could reach it, and a swap between the two would
# have made every go-driven record assert something false about its own trustworthiness.
# Neither string may contain an apostrophe, a dollar sign, a backtick, or a backslash: both reach
# the record writer's python3 -c "..." body through a DOUBLE-quoted bash string (below), so any of
# those four would be expanded or reinterpreted by bash and/or python before the writer ever ran.
driver_control_note_for() {
  case "$1" in
  go) printf '%s' "driver-control is a lower bound on driver-only cost on the Go path too, not a demonstrably tighter one: the Go client decodes the same ExecEvent stream on every arm via stream.Recv(), while grpcurl JSON-formats every received message even when it writes to /dev/null on this arm -- a real difference in decode cost, but as a fraction of the driver-only measurement its net effect on tightness is UNMEASURED (#294)." ;;
  *) printf '%s' "driver-control is a STRICT LOWER BOUND on driver-only cost, not an exact one: the null-responder sends one End and no Chunk events, so grpcurl never decodes a chunk-carrying stream on this arm, while real Execs for mix commands that produce stdout do decode one or more Chunk events per call on the container/microvm arms. Subtracting driver-control latency therefore over-attributes some residue to the backend rather than the driver (#291 item 3)." ;;
  esac
}

exec_error_note_for() {
  case "$1" in
  go) printf '%s' "an in-stream ExecEvent.error is recorded as status=err with its cause classified from the message. The grpcurl path records it as ok, because the relay yields that event and then returns a gRPC OK status. The two clients therefore DISAGREE on throughput, p95 and execErrorsByCause for any rung that produced ExecErrors on the container or microvm arms; they agree exactly on driver-control, where the null-responder never sends one (#294; the relay defect itself is issue #295)." ;;
  *) printf '%s' "an in-stream ExecEvent.error is recorded as status=ok. The relay yields that event and then returns a gRPC OK status, so grpcurl exits 0: an ExecError-failed Exec counts toward throughput, enters the distribution p95 is taken over, and never reaches execErrorsByCause. Pre-existing on this path and fixed on the go path (#294; the relay defect itself is issue #295)." ;;
  esac
}

# arm_in_use reports, via exit status, whether $1 is present in E11_ARMS, so preflight
# can skip a tool or hardware check that no configured arm actually needs (issue #291
# item 5): a SH_E11_ARMS=driver-control run should not be refused over a missing docker
# or /dev/kvm that arm never touches. Called only after validate_arms has already run,
# so E11_ARMS is known to hold nothing but the three recognized arm names.
arm_in_use() {
  local want="$1" arm
  for arm in "${E11_ARMS[@]}"; do
    [ "$arm" = "$want" ] && return 0
  done
  return 1
}

# require_tool refuses a MISSING external binary by name, in preflight, rather than
# letting a rung "run" against a command that is not there -- the same guard, and the same
# wording, e10-lifecycle.sh already carries. E11 had NO tool preflight at all, and that is
# why its first-ever execution reported "converge FAILED after 35ms" three times over
# instead of naming grpcurl, the worker build, or pnpm. A driver that cannot say which
# tool is missing costs an operator a debugging session per missing tool.
require_tool() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is not on PATH: $2"
}

preflight() {
  require_epochrealtime
  # validate_arms runs FIRST: every check below reads E11_ARMS to decide what it needs, so
  # an invented arm name must be refused before any of them run, not after (also see
  # arm_in_use above).
  validate_arms
  # Before anything that depends on the value: build_exec_driver in main() reads it, and the
  # record writer stamps it.
  validate_exec_client
  # grpcurl and go are hard requirements for every arm: grpcurl drives every arm's Exec
  # RPCs, and go builds whichever binary that arm needs (./cmd/worker, ./cmd/microvm-worker,
  # or ./cmd/null-responder). Everything else in this function is conditional on which arms
  # are actually configured (issue #291 item 5): a SH_E11_ARMS=driver-control run touches
  # none of docker, pnpm, or the microVM hardware checks below, so refusing over a missing
  # one would block a run that never needed it.
  require_tool grpcurl "every arm drives its Exec RPCs through grpcurl; without it every timing would measure a client-side error rather than a sandbox"
  require_tool go "the container arm builds ./cmd/worker, the microvm arm builds ./cmd/microvm-worker, and the driver-control arm builds ./cmd/null-responder"
  if arm_in_use container || arm_in_use microvm; then
    require_tool docker "the container and microvm arms both start their own scratch redis in a container; without it the relay has nowhere to publish its presence record"
    require_tool pnpm "the container and microvm arms both start the real sandbox-relay via pnpm --filter @sh/sandbox-relay; without it neither arm can start at all"
    # `ss` is in this branch, not above it, because kill_relay_by_port is called from
    # stop_container_stack and stop_microvm_stack ONLY -- the driver-control arm runs no relay
    # and tears its responder down by pid. Requiring it unconditionally would re-block exactly
    # the SH_E11_ARMS=driver-control run that issue #291 item 5 exists to unblock.
    require_tool ss "between-arm relay teardown identifies the listener by port via ss; without it kill_relay_by_port cannot tell a free port from a missing tool, and the next arm would attach to the previous arm's relay"
  fi
  # The proto must be PRESENT as a file, separately from how grpcurl is told to find it
  # (PROTO_IMPORT_PATH/PROTO_REL_PATH): a missing proto is otherwise indistinguishable from
  # a malformed grpcurl invocation, and both present as an unencodable Exec. e10 carries the
  # same check for the same reason. Every arm drives grpcurl, so this stays unconditional.
  [ -f "$PROTO_FILE" ] ||
    die "the sandbox proto is missing at $PROTO_FILE - grpcurl cannot encode an Exec request without it, so every rung would time a client-side error"
  # check_kvm/check_cgroups/check_swap/check_governor are all about the microVM guest this
  # driver's microvm arm boots (KVM to run it, cgroups v2 for its restore latency, no swap
  # so guest RAM is not paged out, a performance governor for its replenishment CPU burst) --
  # none of them mean anything for a sweep that never boots a guest.
  if arm_in_use microvm; then
    check_kvm
    check_cgroups
    check_swap
    GOVERNOR_STATE="$(check_governor)"
    log "governor: $GOVERNOR_STATE"
  fi
  validate_repo_cache_shape
  mkdir -p "$RESULTS"
}

# static_settings_json prints the four spec section 4.1 settings this task holds
# fixed and records rather than sweeps (see header comment). Pure function, no
# globals read, so it is directly testable in isolation.
static_settings_json() {
  printf '{"standbyIdleS":90,"workspaceIdleS":1800,"replenishDelayS":0.2,"reclaimScanIntervalS":22.5}'
}

# ---------------------------------------------------------------------------
# PSS sampling (spec section 7.3's boxed warning: "Use PSS, not RSS"). Split into
# discover_pids (a real pgrep call, testable against a real spawned process with no
# KVM needed) and pss_bytes_for_pids (a pure reader over $PROC_ROOT, testable
# against a fabricated proc tree so it runs on any platform, Linux smaps_rollup or
# not).
# ---------------------------------------------------------------------------
discover_pids() {
  local pattern="$1"
  pgrep -f -- "$pattern" 2>/dev/null || true
}

# pss_bytes_for_pids sums the "Pss:" line of $PROC_ROOT/<pid>/smaps_rollup across
# every pid given. It NEVER reads VmRSS / RSS from /proc/<pid>/status as a
# fallback: if a pid is still alive (kill -0 succeeds) but its smaps_rollup is
# missing or unreadable, this dies rather than silently substituting a wrong-by-an-
# order-of-magnitude number (spec section 7.3: "reporting ~50 GiB where the truth
# is ~2 GiB ... in the pessimistic direction, so it would cause us to abandon a
# design that works"). A pid that has already exited between discovery and
# sampling contributes 0 (that is a race, not an unreadable file).
pss_bytes_for_pids() {
  local total_kb=0 pid smaps
  for pid in "$@"; do
    [ -n "$pid" ] || continue
    smaps="$PROC_ROOT/$pid/smaps_rollup"
    if [ ! -r "$smaps" ]; then
      if kill -0 "$pid" 2>/dev/null; then
        die "smaps_rollup unreadable for pid $pid ($smaps) - refusing to fall back to RSS (spec section 7.3's boxed warning)"
      fi
      continue # pid exited between discovery and sampling; not an unreadable file
    fi
    # The read can still fail AFTER `-r` said it would succeed, and the two causes need
    # OPPOSITE handling. Observed on both rigs during issue #291's shakedown:
    #   - the pid exited in the window between the test and the read. A race; it contributes 0,
    #     which is correct. Unhandled, awk printed `fatal: cannot open file` to stderr on every
    #     occurrence -- 14 lines in one three-arm smoke -- which reads like a defect and is not.
    #   - the open was REFUSED while the process is still alive: /proc/<pid>/smaps_rollup passes
    #     a mode-bits `-r` test but is gated by ptrace permissions, so another user's process
    #     yields EPERM. Seen on the metal box, where an unscoped `pgrep -f firecracker` matched a
    #     colleague's `more firecracker-jailer-snapshot.sh`.
    # Unhandled, BOTH silently contributed 0: awk's failure left pid_kb empty and bash arithmetic
    # treats an empty string as 0. That is the RSS-fallback failure mode wearing different
    # clothes -- Sigma PSS quietly under-reported, in the optimistic direction, with the record
    # still looking complete. So a live-but-unreadable pid now takes the spec section 7.3 refusal
    # it was always supposed to take.
    local pid_kb pid_rc=0
    pid_kb="$(awk '/^Pss:/{sum+=$2} END{print sum+0}' "$smaps" 2>/dev/null)" || pid_rc=$?
    if [ "$pid_rc" -ne 0 ] || [ -z "$pid_kb" ]; then
      if kill -0 "$pid" 2>/dev/null; then
        die "smaps_rollup for pid $pid ($smaps) passed a readability test and then FAILED to read while the process is still alive - refusing to let it contribute 0 bytes to Sigma PSS (spec section 7.3's boxed warning). Most likely the pid is not ours: check SH_E11_VMM_PROC_PATTERN, which is matched with an unscoped pgrep -f and will pick up any process whose command line contains the pattern, including another user's."
      fi
      continue # exited between the readability test and the read; a race, not a bad file
    fi
    total_kb=$((total_kb + pid_kb))
  done
  echo $((total_kb * 1024))
}

# mem_available_bytes prints MemAvailable in bytes, or a single 0 when /proc/meminfo is
# absent or has no MemAvailable line.
#
# `found=1` in the match action is load-bearing, not tidying (final review H2). In awk,
# `exit` in a main rule RUNS the END block, so without it the guard `if (!found)` was
# always true and this printed the value AND a second line "0" on every Linux host. That
# two-line value was interpolated into host_signals_snapshot's JSON, which made all four
# json.load calls that consume it fail, which left the rung-record writer with empty
# Python expressions and a SyntaxError -- and because this driver runs `set -uo pipefail`
# without `set -e`, nothing aborted: E11 completed its entire sweep having written ZERO
# rung records, on the only platform it can run on. Invisible on darwin, which has no
# /proc/meminfo at all and so takes the `|| echo 0` fallback.
#
# The whole class was audited, not just this line: `grep -rn 'END *{'` over every
# non-test script under deploy/ finds nine other awk END blocks, and the only other
# `exit` reachable from one is inside percentile()'s own END block (both here and in
# e10-lifecycle.sh), where `exit` merely terminates and cannot re-enter END. This was
# the single instance of the shape. require_numeric below is the guard that keeps it
# from being the last one.
# FOUND BY THE FIRST-EVER EXECUTION of this driver on a Linux host with real memory
# (issue #291's PR): the awk form above was `print $2*1024`, and awk's OFMT defaults to "%.6g".
# On MAWK -- Debian's and Ubuntu's default awk -- that applies to an integral product too, so a
# 16 GiB host printed `1.73035e+10`. require_numeric refuses that (its regex is
# `-?[0-9]+(\.[0-9]+)?`), so host_signals_snapshot returned non-zero and EVERY RUNG WAS REFUSED.
#
# It is MAWK-SPECIFIC, and the scope was initially overstated in this comment: gawk and macOS awk
# print `808960000000` for the same expression, because they apply OFMT only to non-integral
# values. Both rigs this project runs on (the 72-cpu/754 GiB metal box and the nested-m8i EC2
# instance) ship gawk and were never affected -- verified on both. So this fix did not rescue a
# metal run; what it does is remove the dependence on which awk a host ships, which is the part
# worth having, since a Debian/Ubuntu host would have recorded nothing at all.
#
# The cluster-free suite passed throughout on every platform, because its fixture uses
# 8192000 kB -- small enough that even mawk prints it as an integer.
#
# `printf "%d"` is NOT the fix: Debian's mawk clamps %d to 32 bits, so it prints 2147483647 --
# silently recording 2 GB where the truth is 17 GB, which is the optimistic-direction wrongness
# spec section 7.3's boxed warning exists to prevent. `printf "%.0f"` works, and so does
# OFMT="%.17g", but both leave the value's correctness dependent on which awk the host ships.
#
# So this reads /proc/meminfo with the same builtin loop the in-rung sampler uses
# (proc_meminfo_available, added for issue #291 item 1). Bash arithmetic is 64-bit, there is no
# format string to get wrong, and it forks nothing. Clobbering SAMPLE_MEM_AVAILABLE_BYTES here is
# safe: the only caller is the POST-LOAD snapshot, which runs after the sampler has been reaped
# and after aggregation has already read the sampler's file.
mem_available_bytes() {
  proc_meminfo_available || SAMPLE_MEM_AVAILABLE_BYTES=0
  printf '%s\n' "$SAMPLE_MEM_AVAILABLE_BYTES"
}

# require_numeric echoes value unchanged when it is exactly ONE line holding one bare
# number, and dies naming the field otherwise.
#
# Both halves matter and the first is the one H2 needed: every line of that broken value
# was individually numeric -- there were simply two of them. A field that is not a single
# bare number cannot be interpolated into JSON, so failing here, naming the field, is
# strictly better than assembling a record that four json.load calls will reject 350 lines
# later with a message about a column number.
require_numeric() {
  local field="$1" value="$2"
  if [ "$(printf '%s\n' "$value" | wc -l | tr -d ' ')" != "1" ] ||
    [ "$(printf '%s\n' "$value" | grep -cxE '\-?[0-9]+(\.[0-9]+)?')" != "1" ]; then
    die "host signal $field is not a single bare number (got '$(printf '%s' "$value" | tr '\n' '|')') - refusing to assemble JSON that would silently cost this rung its record (final review H2)"
  fi
  printf '%s' "$value"
}

# dimension_literal prints the PYTHON LITERAL for one swept dimension: the number itself,
# or `None` (JSON null) for the "-" main() passes on the container arm, which has neither a
# standby depth nor a guest RAM size.
#
# Review 4001908573: `run_density_rung container - - "$c"` fed those dashes straight into
# the record writer's bare numeric interpolations (`'standbyDepth': $d,` -> `: -,`), so
# EVERY container rung raised a SyntaxError, wrote no record, and tripped the `[ -s ]`
# guard -- and since shuffle_e11_arms randomises arm order, roughly half of all runs died
# there before the microvm arm ran at all, with the container stack left running. The arm
# the whole experiment is priced against recorded nothing.
#
# `required=1` (the microvm arm) makes "not applicable" itself a refusal: null there would
# mean the sweep lost the dimension it is sweeping.
dimension_literal() {
  local field="$1" value="$2" required="${3:-0}"
  case "$value" in
  '-' | '')
    [ "$required" != "1" ] ||
      die "$field is '$value' (not applicable) on an arm that requires it - a rung cannot be recorded without the dimension it swept"
    printf 'None'
    return 0
    ;;
  esac
  require_numeric "$field" "$value"
}

# host_cpu_fraction samples /proc/stat twice, "$1" seconds apart (default 1, its only
# caller besides tests passes none), and returns the busy fraction over that window --
# never a single-sample /proc/stat snapshot, which is meaningless (it is a cumulative
# counter since boot).
host_cpu_fraction() {
  local window="${1:-1}" a b idle_a idle_b total_a total_b
  a="$(awk '/^cpu /{print; exit}' "$PROC_ROOT/stat" 2>/dev/null)"
  sleep "$window"
  b="$(awk '/^cpu /{print; exit}' "$PROC_ROOT/stat" 2>/dev/null)"
  if [ -z "$a" ] || [ -z "$b" ]; then
    echo 0
    return 0
  fi
  idle_a="$(awk '{print $5+$6}' <<<"$a")"
  idle_b="$(awk '{print $5+$6}' <<<"$b")"
  total_a="$(awk '{s=0; for(i=2;i<=NF;i++) s+=$i; print s}' <<<"$a")"
  total_b="$(awk '{s=0; for(i=2;i<=NF;i++) s+=$i; print s}' <<<"$b")"
  awk -v ia="$idle_a" -v ib="$idle_b" -v ta="$total_a" -v tb="$total_b" \
    'BEGIN{ dt=tb-ta; di=ib-ia; if (dt>0) printf "%.4f", 1-(di/dt); else print 0 }'
}

# ---------------------------------------------------------------------------
# The in-rung sampler (issue #291 item 1).
#
# host_signals_snapshot below is KEPT, and its values are recorded under postLoad* names, so
# an idle reading can never again pass as an under-load one. What it cannot do is sample
# during the window: host_cpu_fraction SLEEPS for its diff, so calling it from inside a
# concurrency rung would either stall the driver or measure one second of a window that may
# be shorter than that.
#
# The every-tick path here therefore forks NOTHING. proc_stat_totals and
# proc_meminfo_available read /proc with the `read` builtin and a file redirection (not a
# pipe, so no subshell), the CPU fraction is formatted with `printf -v`, and the previous
# /proc/stat reading is kept in globals rather than re-derived -- which is what removes the
# `sleep` from inside a sample. Globals rather than printed values throughout, because
# `x="$(f)"` is a fork and this runs beside the thing being measured.
# ---------------------------------------------------------------------------

# proc_stat_totals sets SAMPLE_IDLE and SAMPLE_TOTAL from the aggregate "cpu " line.
# Returns non-zero when there is no such line, so a caller on a non-Linux host samples
# nothing rather than recording a fabricated 0.
#
# Missing trailing fields (guest / guest_nice are absent on older kernels) are ASSIGNED
# EMPTY by `read`, not left unset, and bash arithmetic treats an empty string as 0 -- so
# `set -u` is satisfied and the sum is still correct.
proc_stat_totals() {
  local label user nice system idle iowait irq softirq steal guest guest_nice
  SAMPLE_IDLE=0
  SAMPLE_TOTAL=0
  while read -r label user nice system idle iowait irq softirq steal guest guest_nice; do
    [ "$label" = "cpu" ] || continue
    SAMPLE_IDLE=$((idle + iowait))
    SAMPLE_TOTAL=$((user + nice + system + idle + iowait + irq + softirq + steal + guest + guest_nice))
    return 0
  done <"$PROC_ROOT/stat"
  return 1
}

# proc_meminfo_available sets SAMPLE_MEM_AVAILABLE_BYTES from MemAvailable, in bytes.
# Returns non-zero when there is no MemAvailable line. mem_available_bytes' awk form stays
# in place for the post-load snapshot, where one fork per rung costs nothing.
#
# The third `read` variable is needed (two would put "8192000 kB" in $value) and named
# _rest because SC2034 -- "appears unused" -- is a WARNING, and shellcheck at -S warning is
# a gate here, so `unit` would fail `make lint`.
proc_meminfo_available() {
  local key value _rest
  SAMPLE_MEM_AVAILABLE_BYTES=0
  while read -r key value _rest; do
    if [ "$key" = "MemAvailable:" ]; then
      SAMPLE_MEM_AVAILABLE_BYTES=$((value * 1024))
      return 0
    fi
  done <"$PROC_ROOT/meminfo"
  return 1
}

# host_sampler_tick appends ONE line to $1:
#
#     <cpuFraction> <memAvailableBytes> <pssBytes|-|refused> <processCount|->
#
# "-" marks a tick that did not carry the low-cadence signals; sampler_field skips those,
# which is how pssSamples can legitimately differ from hostCpuSamples in the record.
# "refused" (pssBytes column only) marks a low-cadence tick that DID try, but
# pss_bytes_for_pids died on an unreadable smaps_rollup for a still-live pid (spec section
# 7.3's boxed warning) -- a distinct, countable event, not an absent sample. See
# pssRefusedTicks in run_density_rung (issue #291 item 4).
#
# The CPU fraction is computed in scaled integer arithmetic and the decimal point spliced in
# by `printf -v`, because awk or bc would be a fork per tick. It is clamped to [0, 1]: a
# CPU hotplug or a counter wrap can make the idle delta exceed the total delta, and a
# negative "fraction" would be interpolated straight into the rung's JSON.
host_sampler_tick() {
  local out_file="$1"
  local di dt scaled frac pss proc_count p vmm_pids virtiofsd_pids
  proc_stat_totals || return 1
  di=$((SAMPLE_IDLE - SAMPLE_PREV_IDLE))
  dt=$((SAMPLE_TOTAL - SAMPLE_PREV_TOTAL))
  SAMPLE_PREV_IDLE="$SAMPLE_IDLE"
  SAMPLE_PREV_TOTAL="$SAMPLE_TOTAL"
  scaled=0
  if [ "$dt" -gt 0 ]; then
    scaled=$(((dt - di) * 10000 / dt))
  fi
  [ "$scaled" -ge 0 ] || scaled=0
  [ "$scaled" -le 10000 ] || scaled=10000
  printf -v frac '%d.%04d' "$((scaled / 10000))" "$((scaled % 10000))"
  proc_meminfo_available || SAMPLE_MEM_AVAILABLE_BYTES=0
  SAMPLE_TICK=$((SAMPLE_TICK + 1))
  pss="-"
  proc_count="-"
  # Tick 1 is ALWAYS a low-cadence tick. Otherwise a rung whose window fits in fewer than
  # SAMPLE_LOW_EVERY ticks would record pssSamples=0 and processCountSamples=0 while having
  # CPU samples -- and standbysResident is derived from processCount, so it would have had to
  # fall back to the post-load count, reintroducing exactly the idle reading this fixes.
  if [ "$SAMPLE_TICK" -eq 1 ] || [ $((SAMPLE_TICK % SAMPLE_LOW_EVERY)) -eq 0 ]; then
    vmm_pids="$(discover_pids "$VMM_PROC_PATTERN")"
    virtiofsd_pids="$(discover_pids "$VIRTIOFSD_PROC_PATTERN")"
    # A `die` inside pss_bytes_for_pids exits only this command substitution's subshell, so
    # the assignment lands empty with a non-zero status. That refusal (spec section 7.3's
    # boxed warning: a still-live pid with an unreadable smaps_rollup) is a DIFFERENT event
    # from an ordinary un-sampled tick, so it gets a distinct marker, "refused", rather than
    # "-" -- otherwise it would silently vanish from this tick with no trace anywhere except
    # the post-load snapshot's own separate refusal path, which only covers the moment after
    # the window closes, not any in-window tick (issue #291 item 4). sampler_field and
    # sampler_marker_count both know to treat "refused" as not-a-number.
    # shellcheck disable=SC2086 # word-splitting into pss_bytes_for_pids' "$@" is intended
    pss="$(pss_bytes_for_pids $vmm_pids $virtiofsd_pids)" || pss="refused"
    [ -n "$pss" ] || pss="-"
    proc_count=0
    # shellcheck disable=SC2086
    for p in $vmm_pids $virtiofsd_pids; do
      [ -z "$p" ] || proc_count=$((proc_count + 1))
    done
  fi
  printf '%s %s %s %s\n' "$frac" "$SAMPLE_MEM_AVAILABLE_BYTES" "$pss" "$proc_count" >>"$out_file"
}

# host_sampler_loop ticks into $1 until $2 exists, then, ONLY if no full tick has landed yet
# (SAMPLE_TICK == 0), takes ONE final tick provided at least SAMPLE_MIN_TICK_MS has elapsed
# since the loop started. Meant to be backgrounded by run_density_rung immediately after
# wall_t0 and reaped immediately after wall_t1.
#
# The no-full-tick gate matters (issue #291 item 2): once a rung has a real, full-interval
# tick, a second tick taken at stop is not a peer sample -- its window runs from the last
# full tick to "sampler noticed the stop file", which for a rung that finishes near an
# interval boundary is mostly post-window idle time. Averaging that in at equal weight with
# real ticks biases hostCpuFraction toward "idle", the same direction as the original
# driver-cost artifact. So once SAMPLE_TICK is nonzero, stop takes no extra tick -- the rung
# keeps whatever full ticks it earned and nothing else. Only a rung shorter than one full
# interval (SAMPLE_TICK still 0 at stop) uses the elapsed-time floor to still get exactly one
# sample instead of zero.
#
# It waits in SAMPLE_SLICE_MS slices rather than one SAMPLE_INTERVAL_MS sleep so that the
# stop file is noticed promptly. That costs one `sleep` fork per slice -- ten a second
# against the ~370 process creations a second issue #291 item 2 removed.
host_sampler_loop() {
  local out_file="$1" stop_file="$2"
  local slices_per_tick slice=0 last_ms slice_s
  slices_per_tick=$((SAMPLE_INTERVAL_MS / SAMPLE_SLICE_MS))
  [ "$slices_per_tick" -ge 1 ] || slices_per_tick=1
  printf -v slice_s '%d.%03d' "$((SAMPLE_SLICE_MS / 1000))" "$((SAMPLE_SLICE_MS % 1000))"
  proc_stat_totals || return 0 # no /proc/stat here: sample nothing rather than lie
  SAMPLE_PREV_IDLE="$SAMPLE_IDLE"
  SAMPLE_PREV_TOTAL="$SAMPLE_TOTAL"
  SAMPLE_TICK=0
  set_epoch_ms
  last_ms="$EPOCH_MS"
  while :; do
    if [ -e "$stop_file" ]; then
      if [ "$SAMPLE_TICK" -eq 0 ]; then
        set_epoch_ms
        if [ $((EPOCH_MS - last_ms)) -ge "$SAMPLE_MIN_TICK_MS" ]; then
          host_sampler_tick "$out_file" || true
        fi
      fi
      return 0
    fi
    sleep "$slice_s"
    slice=$((slice + 1))
    [ "$slice" -ge "$slices_per_tick" ] || continue
    slice=0
    host_sampler_tick "$out_file" || return 0
    set_epoch_ms
    last_ms="$EPOCH_MS"
  done
}

# stop_host_sampler kills the backgrounded sampler if one is running. It runs FIRST in
# cleanup_on_exit, before the `rm -rf $E11_TMPDIR`, because host_sampler_loop polls for a
# stop file under that root: once the root is gone the file can never appear, and the
# subshell would spin forever appending to a deleted path. `${VAR:-}` because the trap can
# fire before this is ever assigned.
stop_host_sampler() {
  [ -n "${E11_SAMPLER_PID:-}" ] || return 0
  kill "${E11_SAMPLER_PID:-}" 2>/dev/null
  E11_SAMPLER_PID=""
  return 0
}

# sampler_field prints one statistic over one COLUMN of a sampler file. `stat` is
# mean|peak|min|count; `fmt` is a printf format (default %.4f -- pass %.0f for the byte
# columns, whose consumers want integers, and whose mean is rounded rather than truncated).
#
# `fmt` is IGNORED for stat=count: a count cannot be fractional, so it always prints a bare
# integer regardless of what is passed. Call sites below that ask for `count` omit the
# fourth argument rather than passing a now-documented-as-inert '%d' (final review M12).
#
# Cells holding "-" OR "refused" are SKIPPED, not read as zero: "-" means the tick did not
# carry the low-cadence signals, "refused" means it did but pss_bytes_for_pids died on an
# unreadable smaps_rollup for a still-live pid (spec section 7.3's boxed warning) -- see
# host_sampler_tick and pssRefusedTicks in run_density_rung (issue #291 item 4). Neither is a
# 0, and a 0 in a mean is a claim about memory while an absent sample is not. It is also why
# pssSamples can legitimately be smaller than hostCpuSamples.
#
# An empty file, or a column with no numeric cell, is the ABSENCE of a measurement and
# returns non-zero rather than printing 0 -- the same refusal percentile makes, for the same
# reason. `count` is the exception: it prints 0, so a caller can tell "no samples" from
# "the aggregation failed".
#
# One awk per statistic per rung, after the sampler has been reaped: nothing here can
# perturb a measurement.
sampler_field() {
  local file="$1" col="$2" stat="$3" fmt="${4:-%.4f}"
  [ -s "$file" ] || {
    [ "$stat" = "count" ] && { echo 0; return 0; }
    return 1
  }
  awk -v col="$col" -v stat="$stat" -v fmt="$fmt" '
    $col != "-" && $col != "refused" {
      v = $col + 0
      n++
      s += v
      if (n == 1 || v > mx) mx = v
      if (n == 1 || v < mn) mn = v
    }
    END {
      if (stat == "count") { print n + 0; exit 0 }
      if (n == 0) { exit 1 }
      if (stat == "mean") { printf fmt, s / n }
      else if (stat == "peak") { printf fmt, mx }
      else if (stat == "min") { printf fmt, mn }
      else { exit 1 }
    }' "$file"
}

# sampler_marker_count counts ticks in $1 whose column $2 holds exactly the literal $3
# (e.g. "refused") rather than a number or "-". Used for pssRefusedTicks: a refusal is a
# distinct, countable event, not indistinguishable from an ordinary un-sampled tick.
sampler_marker_count() {
  local file="$1" col="$2" marker="$3"
  [ -s "$file" ] || {
    echo 0
    return 0
  }
  awk -v col="$col" -v marker="$marker" '$col == marker {n++} END{print n + 0}' "$file"
}

# host_cpu_count prints the online CPU count, for coresBusy. `getconf _NPROCESSORS_ONLN` is
# the portable fallback (it works on darwin, where the test suite runs, and nproc may not
# be installed). One fork per rung.
host_cpu_count() {
  local n=""
  if command -v nproc >/dev/null 2>&1; then
    n="$(nproc 2>/dev/null)" || n=""
  fi
  if [ -z "$n" ]; then
    n="$(getconf _NPROCESSORS_ONLN 2>/dev/null)" || n=""
  fi
  [ -n "$n" ] || n=1
  printf '%s' "$n"
}

# host_signals_snapshot prints one JSON object: pssBytes (VMM + virtiofsd, PSS
# only), memAvailableBytes, hostCpuFraction, processCount.
#
# Every field is validated before it reaches the printf, and the function RETURNS
# NON-ZERO (printing nothing) rather than emitting a malformed object. This is the
# integration point final-review H2 exposed: pss_bytes_for_pids had its own extracted
# test and a real non-vacuousness proof, while the JSON assembly that consumes it -- the
# only place any of these values is used -- had no test at all, so a malformed SIBLING
# field took the whole rung record down with it.
#
# Each `|| return 1` is also what makes `die` inside these helpers effective at all. A
# `die` in `x="$(helper)"` exits only the command substitution's SUBSHELL; with no
# `set -e` the assignment simply lands empty and the script sails on. That silently
# defanged even pss_bytes_for_pids's "refusing to fall back to RSS" refusal, which spec
# section 7.3's boxed warning makes the single most important failure in this file.
# Checking the status here is what turns those refusals back into stops.
#
# $1 ("require_vmm", default 0) is what makes a ZERO PSS TOTAL a refusal rather than a
# value on the arm where it can only be wrong (review 4001908599). With no match for
# $VMM_PROC_PATTERN, all_pids is empty, pss_bytes_for_pids returns 0, and require_numeric
# happily accepts it -- so the rung records pssBytes: 0. That is reachable from a mis-set
# SH_E11_VMM_PROC_PATTERN, from the jailer renaming the process, or from the arm simply
# not being up, and it is wrong in the OPTIMISTIC direction: the single number E11 exists
# to produce goes missing while the record still looks complete, which is the same failure
# mode as the RSS fallback that pss_bytes_for_pids goes to real lengths to refuse.
#
# It is a parameter, not an unconditional check, because ZERO IS CORRECT on the container
# arm (no VMM at all) and for the virtiofsd pattern on the Firecracker-only microvm arm
# (see the header). Only "the microvm arm found no VMM process" is impossible-by-
# construction, and only main()'s microvm call sites pass 1.
host_signals_snapshot() {
  local require_vmm="${1:-0}"
  local vmm_pids virtiofsd_pids all_pids pss mem cpu count
  vmm_pids="$(discover_pids "$VMM_PROC_PATTERN")"
  if [ "$require_vmm" = "1" ] && [ -z "$vmm_pids" ]; then
    die "no host process matches the VMM pattern '$VMM_PROC_PATTERN' while the microvm arm is running: PSS would total 0 bytes, and a zero is a REFUSAL here, not a measurement (spec section 7.3's boxed warning). Check SH_E11_VMM_PROC_PATTERN against the process the jailer actually spawns, and that the worker is up."
  fi
  virtiofsd_pids="$(discover_pids "$VIRTIOFSD_PROC_PATTERN")"
  # shellcheck disable=SC2086 # word-splitting into pss_bytes_for_pids's "$@" is intended
  all_pids="$vmm_pids $virtiofsd_pids"
  # shellcheck disable=SC2086
  pss="$(pss_bytes_for_pids $all_pids)" || return 1
  pss="$(require_numeric pssBytes "$pss")" || return 1
  if [ "$require_vmm" = "1" ] && [ "$pss" = "0" ]; then
    die "the VMM pattern '$VMM_PROC_PATTERN' matched pids [$(printf '%s' "$vmm_pids" | tr '\n' ' ')] but their PSS summed to 0 bytes - refusing a zero total on the microvm arm (spec section 7.3): a real Firecracker guest is never 0, so \$SH_E11_PROC_ROOT or the smaps_rollup content is wrong, not the memory."
  fi
  mem="$(require_numeric memAvailableBytes "$(mem_available_bytes)")" || return 1
  cpu="$(require_numeric hostCpuFraction "$(host_cpu_fraction 1)")" || return 1
  count="$(require_numeric processCount "$(printf '%s\n%s\n' "$vmm_pids" "$virtiofsd_pids" | grep -c '[0-9]' || true)")" || return 1
  printf '{"pssBytes":%s,"memAvailableBytes":%s,"hostCpuFraction":%s,"processCount":%s}' \
    "$pss" "$mem" "$cpu" "$count"
}

# ---------------------------------------------------------------------------
# Timing primitives (issue #291 item 2).
#
# $EPOCHREALTIME is a bash VARIABLE (bash >= 5.0), so reading it costs no process. It
# replaces the two `date +%s%N` forks grpc_exec_record used to take per Exec -- and,
# because t0 was stamped before the compound whose argument list held two python3 command
# substitutions, those two interpreter startups were inside the measured latency.
# Resolution drops from nanoseconds to microseconds, which is immaterial for millisecond
# latencies.
#
# Both helpers avoid command substitution deliberately: `x="$(f)"` is a FORK, which is the
# entire thing being removed here. epoch_delta_ms prints (it is called once per Exec, where
# one fork for the substitution is what the caller already pays for the assignment), while
# set_epoch_ms writes a global (it is called inside the sampler's tick loop, where nothing
# may fork).
# ---------------------------------------------------------------------------
EPOCH_MS=0

# epoch_delta_ms prints the whole milliseconds between two $EPOCHREALTIME readings.
# Stripping the '.' turns <seconds>.<6 digits> into integer MICROSECONDS, which bash's
# 64-bit arithmetic holds with room to spare (1.8e15 today). `10#` is defensive against a
# reading whose integer part could ever begin with 0.
epoch_delta_ms() {
  local a="${1/./}" b="${2/./}"
  echo $(((10#$b - 10#$a) / 1000))
}

# set_epoch_ms sets EPOCH_MS to now, in whole milliseconds, with no subprocess.
set_epoch_ms() {
  local e="${EPOCHREALTIME/./}"
  EPOCH_MS=$((10#$e / 1000))
}

# require_epochrealtime refuses a shell whose $EPOCHREALTIME is missing or not
# <digits>.<digits>. bash < 5.0 does not define it at all -- and bash 3.2 is both /bin/sh
# and /bin/bash on macOS -- so under `set -u` the FIRST timed Exec would abort its slot,
# every slot, and the rung would refuse with a message about converge. A locale rendering a
# decimal comma is the other way this reads wrong; LC_ALL=C above pins it.
require_epochrealtime() {
  [[ "${EPOCHREALTIME:-}" =~ ^[0-9]+\.[0-9]+$ ]] ||
    die "\$EPOCHREALTIME is '${EPOCHREALTIME:-<unset>}', not <seconds>.<microseconds>: this driver times every Exec from it (issue #291 item 2). Unset means bash < 5.0 (bash 3.2 is /bin/bash on macOS - run this under a bash 5 on PATH); a decimal comma means a locale is overriding the LC_ALL=C pin at the top of this file."
}

# ---------------------------------------------------------------------------
# json_escape / percentile -- duplicated from e10-lifecycle.sh verbatim (see that
# file's own copies); small enough that duplication beats sourcing a sibling
# script for these two alone.
# ---------------------------------------------------------------------------
json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"
}

percentile() {
  local p="$1" file="$2"
  # A missing or EMPTY input file is not a zero percentile, it is the absence of any
  # measurement -- so this refuses (prints nothing, returns non-zero) and the caller names
  # the rung. Two defects lived in the old `print 0` form (review 4001908597):
  #
  #   1. the value. `p95Ms: 0` at a rung where every Exec failed is not a fast rung, and
  #      detectKnee reads it as the healthiest point in the ladder; at c=1 it makes the
  #      baseline bound (p95 * degradeX) zero and marks every later rung unhealthy.
  #   2. the SHAPE. `sort -n` on a missing file exits 2, awk still printed 0, and
  #      `pipefail` propagated sort's status -- so a caller's `|| echo 0` appended a
  #      SECOND line, which is exactly the two-line-value defect final review H2 fixed in
  #      mem_available_bytes. The `[ -s ]` guard means `sort` is never handed a missing
  #      file at all, and the awk END branch exits non-zero instead of printing.
  [ -s "$file" ] || return 1
  sort -n "$file" | awk -v p="$p" '
    { a[NR] = $1; n = NR }
    END {
      if (n == 0) { exit 1 }
      rank = int((p / 100.0) * n)
      if (rank < 1) rank = 1
      if (rank > n) rank = n
      print a[rank]
    }'
}

# e11_tool_call_mix is IDENTICAL to e10-lifecycle.sh's rung1_tool_call_mix
# (duplicated rather than sourced, for the same reason as the preflight checks
# above): spec section 7.3 requires E11 to drive "the Exec mix E10 measured", so
# reusing a different mix here would violate the spec's own cross-reference.
e11_tool_call_mix() {
  echo "true"
  echo "head -c 1048576 /dev/zero | wc -c"
  echo "ls -la /tmp"
  echo "cat /etc/hostname"
  echo "echo e11-mix > /tmp/e11-mix-$$.tmp"
  echo "grep -c e11 /tmp/e11-mix-$$.tmp"
  echo "rm -f /tmp/e11-mix-$$.tmp"
}

# escaped_mix prints one PRE-ESCAPED JSON string literal (surrounding double quotes
# included) per command of e11_tool_call_mix, in the mix's own order. It is called ONCE PER
# RUNG, before the rung's slots start -- this is where the two python3 interpreter
# startups per Exec went (issue #291 item 2). It uses the same json_escape the timed loop
# used to call, so the bytes it produces are identical by construction rather than by a
# reimplementation of JSON escaping in bash, which is where this change's real risk was.
escaped_mix() {
  local cmd
  while IFS= read -r cmd; do
    json_escape "$cmd"
  done < <(e11_tool_call_mix)
}

# write_rung_plan emits ONE rung's instruction set for remote-worker/cmd/exec-driver
# (issue #294), as JSON, at $1.
#
# A PURE FUNCTION OF ITS ARGUMENTS -- no globals read -- so the test suite can drive it in
# isolation, the same property static_settings_json's comment claims for the same reason.
#
# Everything travels through ARGV, and python3's json.dumps does every escape. bash passes each
# array element as one argv entry, so a workspace key or a path containing a space, quote,
# backslash or tab cannot be mis-split -- which a delimited temp file could not promise. It also
# keeps JSON escaping in the one place this driver already puts it (json_escape), rather than
# adding a second, hand-rolled implementation in bash.
#
# The mix and the slot fields are VARIADIC, after a count of each, because bash cannot pass
# arrays by value: the alternative was reading caller arrays by name, which would make this
# untestable in isolation. Slot fields come in groups of four, in order:
# reqBase workspaceKey timesFile errFile.
#
# Called BEFORE wall_t0 is stamped. Nothing in here may end up inside the timed window --
# deploy/microvm/tests/e11-density.test.sh's fork guard asserts that python3 does not appear
# between the two stamps.
#
# THE CLOSING BRACES AND BRACKETS IN THE PYTHON BODY BELOW ARE INDENTED ON PURPOSE. The test
# suite extracts functions from this file by scanning for the closing bare `}` at column 0, and
# it only knows to skip over an embedded `python3 -c "` block spelled with a DOUBLE quote (see
# extract_fn). This block uses a single quote, so a `}` at column 0 here would terminate the
# extraction early and the suite would source a truncated function. Python accepts an indented
# closing delimiter, so this costs nothing; un-indenting it silently breaks two test sections.
write_rung_plan() {
  local out_path="$1" target="$2" sandbox_id="$3" iters="$4" warmup="$5" exec_timeout_s="$6" deadline_s="$7" mix_count="$8" slot_count="$9"
  shift 9
  python3 -c '
import json, sys

out, target, sandbox, iters, warmup, tmo, deadline, nmix, nslots = sys.argv[1:10]
nmix, nslots = int(nmix), int(nslots)
rest = sys.argv[10:]
if len(rest) != nmix + 4 * nslots:
    sys.stderr.write(
        "e11: write_rung_plan was given %d variadic argument(s) but its counts say %d mix "
        "command(s) plus 4 fields for each of %d slot(s) = %d. Refusing to write a plan that "
        "would silently shrink the mix every slot loops over, or drop a slot.\n"
        % (len(rest), nmix, nslots, nmix + 4 * nslots))
    sys.exit(1)
mix = rest[:nmix]
fields = rest[nmix:]
slots = [
    {
        "reqBase": int(fields[i * 4]),
        "workspaceKey": fields[i * 4 + 1],
        "timesFile": fields[i * 4 + 2],
        "errFile": fields[i * 4 + 3],
    }
    for i in range(nslots)
    ]
plan = {
    "target": target,
    "sandboxId": sandbox,
    "itersPerSlot": int(iters),
    "warmupPerSlot": int(warmup),
    "execTimeoutS": int(tmo),
    "callDeadlineS": int(deadline),
    "mix": mix,
    "slots": slots,
    }
with open(out, "w") as fh:
    json.dump(plan, fh, indent=2)
' "$out_path" "$target" "$sandbox_id" "$iters" "$warmup" "$exec_timeout_s" "$deadline_s" "$mix_count" "$slot_count" "$@" ||
    die "write_rung_plan could not write the rung plan to $out_path (its reason is above) - the Go Exec client has nothing to drive, so refusing to enter the timed window"
}

# ---------------------------------------------------------------------------
# The Exec RPC itself, extended from e10-lifecycle.sh's grpc_exec_ms with a
# workspace_key (proto/sandbox/v1/sandbox.proto: Exec.workspace_key, field 6,
# nested inside Exec, NOT a top-level ExecRequest field) and error classification
# for execErrorsByCause.
# ---------------------------------------------------------------------------
grpc_exec_record() {
  local relay_port="$1" sandbox_id="$2" ws_json="$3" cmd_json="$4" req_id="$5" out_file="$6" err_log="$7"
  local t0 t1 a b us frac ms cause status
  # ws_json and cmd_json arrive ALREADY ESCAPED, quotes included (escaped_mix / the caller's
  # one-shot workspace_key escape). err_log is a fixed per-slot path: `2>` truncates it on
  # every call, so the old mktemp+rm pair bought nothing. req_id is a number and needs no
  # escaping.
  t0="$EPOCHREALTIME"
  if grpcurl -plaintext -max-time "$EXEC_MAX_TIME_S" -import-path "$PROTO_IMPORT_PATH" -proto "$PROTO_REL_PATH" \
    -d "{\"sandbox_id\":\"$sandbox_id\",\"exec\":{\"req_id\":$req_id,\"command\":$cmd_json,\"timeout_s\":30,\"workspace_key\":$ws_json}}" \
    "localhost:${relay_port}" sandbox.v1.SandboxExec/Exec >/dev/null 2>"$err_log"; then
    t1="$EPOCHREALTIME"
    status="ok"
    cause="-"
  else
    t1="$EPOCHREALTIME"
    status="err"
    # Subprocess forks in this function: grpcurl above (always -- it is the thing being
    # measured) and these greps (only after an Exec has already failed, so they cannot
    # contribute to a healthy rung's latency, and a failed Exec's latency is not in the
    # distribution p95 is taken over anyway). ms below is pure arithmetic expansion plus
    # parameter expansion, no command substitution and no extra fork (issue #291 item 1) --
    # so that count is complete.
    if grep -qi "workspace_key" "$err_log"; then
      cause="empty-workspace-key"
    elif grep -qi "mem" "$err_log"; then
      cause="memory-gate"
    elif grep -qi "maxruns\|max-runs\|max_runs" "$err_log"; then
      cause="max-runs"
    elif grep -qi "spawn" "$err_log"; then
      cause="spawn-failure"
    elif grep -qi "vsock" "$err_log"; then
      cause="vsock-short-response"
    else
      cause="unknown"
    fi
  fi
  a="${t0/./}"; b="${t1/./}"
  us=$(( (10#$b - 10#$a) ))
  # Fractional ms with NO fork: parameter expansion and arithmetic only. `1000 + us % 1000`
  # lands in 1000..1999 so `${frac#1}` is the remainder zero-padded to three digits -- printf
  # would be a command substitution, and this function is asserted to contain none (#291 item 2).
  frac=$((1000 + us % 1000))
  ms="$((us / 1000)).${frac#1}"
  echo "$ms $status $cause" >>"$out_file"
}

# build_converge_script reproduces harness/src/converge.ts:buildConvergeScript()
# verbatim (see that file), so this driver's converge step is the SAME script the
# harness actually runs in production, not an invented substitute.
build_converge_script() {
  local repo_url="$1" ref="$2" run_id="$3" leaf
  leaf="/workspace/leaves/${run_id}"
  cat <<SCRIPT
set -eu
REPO=/workspace/repo; LOCK=/workspace/.sh-fetch.lock; LEAF='${leaf}'
mkdir -p /workspace/leaves
(
  flock 9
  [ -d "\$REPO/.git" ] || { rm -rf "\$REPO"; git init -q "\$REPO"; }
  git -C "\$REPO" fetch --quiet '${repo_url}' '${ref}' || { rm -rf "\$REPO"; git init -q "\$REPO"; git -C "\$REPO" fetch --quiet '${repo_url}' '${ref}'; }
) 9>"\$LOCK"
COMMIT=\$(git -C "\$REPO" rev-parse FETCH_HEAD)
[ -d "\$LEAF" ] || git -C "\$REPO" worktree add --quiet --detach "\$LEAF" "\$COMMIT"
printf '%s' "\$LEAF"
SCRIPT
}

# converge_slot times ONE Exec running build_converge_script's output, SEPARATELY
# from the slot's Exec-mix loop (spec section 7.5: "Time converge separately from
# Exec ... or the cost hides inside the rungs"). Prints elapsed ms.
# It also RETURNS THE RPC's OWN STATUS. A FAILED converge is not a fast converge: the
# workspace was never prepared, so every Exec in that slot afterwards measures something
# else, and timing the failure would put a small number in convergeMsP50 -- wrong in the
# "looks cheap" direction. The slot below turns a non-zero status here into a slot failure,
# and run_density_rung refuses the rung.
# req_id is a PARAMETER, not the constant 0 it used to be. Every slot's converge used
# req_id 0 against one shared sandbox_id, so at c>=2 two concurrent converges collided --
# see run_density_rung's own comment for what that collision does.
# ---------------------------------------------------------------------------
# Slot identity (issue #291 item 3). Phase 2 RECOMPUTES a slot's identity rather than
# inheriting it from phase 1 -- the two phases are different subshells -- so all three
# derivations live in one place each and cannot drift into two slots sharing a workspace or
# a req_id space.
# ---------------------------------------------------------------------------
slot_run_id() {
  printf 'e11-%s-d%s-ram%s-c%s-slot%s' "$1" "$2" "$3" "$4" "$5"
}

# The microvm arm REFUSES an empty workspace_key (proto/sandbox/v1/sandbox.proto's own doc
# comment on Exec.workspace_key); the container arm may omit it, which means today's single
# shared workspace. The driver-control arm follows the container path.
slot_workspace_key() {
  local arm="$1" run_id="$2"
  case "$arm" in
  microvm) printf '%s' "$run_id" ;;
  *) : ;;
  esac
}

# A DISJOINT req_id space per slot, base 1000000 apart. Every slot in a rung talks to ONE
# shared sandbox_id and the relay demultiplexes responses BY req_id, so uniqueness is the
# caller's job: two concurrent Execs sharing a req_id collide, and on the validation rig one
# of the pair got the other's chunks and hung for 33 minutes. Converge uses the base itself
# and the Exec mix counts up from it, and phase 1 drains fully before phase 2 issues
# anything, so the collision cannot recur across the barrier either.
slot_req_base() {
  echo $(($1 * 1000000))
}

converge_slot() {
  local relay_port="$1" sandbox_id="$2" workspace_key="$3" run_id="$4" req_id="$5"
  local script t0 t1 rc=0
  script="$(build_converge_script "$CONVERGE_REPO_URL" "$CONVERGE_REF" "$run_id")"
  t0="$(date +%s%N)"
  grpcurl -plaintext -max-time "$CONVERGE_MAX_TIME_S" -import-path "$PROTO_IMPORT_PATH" -proto "$PROTO_REL_PATH" \
    -d "{\"sandbox_id\":\"$sandbox_id\",\"exec\":{\"req_id\":$req_id,\"command\":$(json_escape "$script"),\"timeout_s\":300,\"workspace_key\":$(json_escape "$workspace_key")}}" \
    "localhost:${relay_port}" sandbox.v1.SandboxExec/Exec >/dev/null 2>>"$RESULTS/e11-converge.log" || rc=$?
  t1="$(date +%s%N)"
  echo $(((t1 - t0) / 1000000))
  return "$rc"
}

# ---------------------------------------------------------------------------
# Arm stacks
# ---------------------------------------------------------------------------
drop_caches() {
  if [ -w /proc/sys/vm/drop_caches ]; then
    echo 3 >/proc/sys/vm/drop_caches 2>/dev/null || log "drop_caches: not permitted, continuing (informational only)"
  else
    log "drop_caches: /proc/sys/vm/drop_caches not writable here, continuing"
  fi
}

# wait_for_relay_port blocks until something is LISTENING on a loopback port, and dies
# naming the log if it never happens. Both drivers previously did `sleep 2` and hoped.
#
# Found on E11's first execution: the relay crashed at startup (a missing package -- the
# pi-fork submodule was not built), nothing was listening, the worker retried a refused
# connection five times, and the first thing the operator saw was a converge TIMEOUT ten
# seconds later. The cause was sitting in the relay log, which nothing pointed at. A stack
# that did not come up must fail where it failed, not as a latency measurement downstream.
wait_for_relay_port() {
  local port="$1" logfile="$2" what="$3" deadline=$((SECONDS + 30))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  echo "----- last 20 lines of $logfile -----" >&2
  tail -n 20 "$logfile" >&2 2>/dev/null || echo "(no log at $logfile)" >&2
  echo "-------------------------------------" >&2
  die "$what never started listening on 127.0.0.1:$port within 30s - its log is above and in $logfile. Every Exec after this point would have measured a client-side dial failure, not a sandbox."
}

# wait_for_worker_attached blocks until a worker has ATTACHED to the relay, and dies naming
# its log if it never does. Both drivers previously did `sleep 2` and hoped.
#
# The window is not trivial startup. microvm-worker attaches only AFTER PinMemoryFile (an
# mlock whose cost scales with guest RAM), RaiseMemlockLimit, SweepOrphans and pool.Probe --
# and Probe is a FULL restore/resume/run/destroy of a real VM, ~300ms on the validation rig by
# E10's own decomposition. Two seconds usually clears it; the margin is thin and it grows on
# hardware with more guest RAM.
#
# The failure it prevents is one-shot fatal: until the attach lands the relay answers
# "no live worker" INSTANTLY, so E11's converge fails in milliseconds -- and a converge failure
# aborts the entire sweep, both arms, with no warmup tolerance.
#
# Waits on the log line both binaries print (cmd/worker and cmd/microvm-worker). That couples
# to a string, so the timeout dumps the log: if the wording ever changes this becomes a loud,
# diagnosable failure instead of the silent mis-blame `sleep 2` produced.
wait_for_worker_attached() {
  local logfile="$1" what="$2" deadline=$((SECONDS + 60))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if grep -q 'attached, serving execs' "$logfile" 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  echo "----- last 20 lines of $logfile -----" >&2
  tail -n 20 "$logfile" >&2 2>/dev/null || echo "(no log at $logfile)" >&2
  echo "-------------------------------------" >&2
  die "$what never attached to the relay within 60s - its log is above and in $logfile. Until a worker attaches the relay answers 'no live worker' immediately, so every Exec after this point would have measured that refusal rather than a sandbox."
}

# assert_relay_alive is a LIVENESS check, distinct from wait_for_relay_port's readiness check
# -- and the distinction is not academic. On the validation rig a relay bound :8444, a worker
# attached to it, and then the relay DIED on an unhandled Redis 'error' event
# (SocketClosedUnexpectedlyError). Nothing noticed: the port check had already passed, so the
# next Exec burned its full client deadline (360s) before the sweep aborted, and the cause sat
# unread in the relay's own log.
#
# Unlike the supervised deployments, these drivers start the relay themselves and nothing
# restarts it, so a Redis blip mid-run is a lost run rather than a blip. Checking between rungs
# turns six silent minutes into an immediate failure that names the log.
assert_relay_alive() {
  local port="$1" logfile="$2" what="$3"
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    return 0
  fi
  echo "----- last 20 lines of $logfile -----" >&2
  tail -n 20 "$logfile" >&2 2>/dev/null || echo "(no log at $logfile)" >&2
  echo "-------------------------------------" >&2
  die "$what is no longer listening on 127.0.0.1:$port - it started and then DIED mid-run; its log is above and in $logfile. Every Exec from here would time out against a dead relay rather than measure anything."
}

# shuffle_e11_arms prints $E11_ARMS in randomized order (spec section 7.5: page-cache
# asymmetry between arms), same technique as e10-lifecycle.sh's shuffle_arms. It reads the
# configured list rather than a hardcoded pair, so adding the driver-control arm did not need
# a second randomiser that could drift from this one.
shuffle_e11_arms() {
  printf '%s\n' "${E11_ARMS[@]}" |
    awk -v seed="$(($$ + $(date +%s)))" 'BEGIN{srand(seed)} {print rand()"\t"$0}' | sort -n | cut -f2-
}

# kill_relay_by_port kills whatever is listening on $1, BY PORT rather than by
# E11_RELAY_PID. That PID comes from `pnpm ... start & echo $!` inside a subshell, and on
# this host pnpm stays running as a supervisor over a separate node child rather than
# exec-ing into it -- so killing E11_RELAY_PID kills pnpm and leaves its child holding the
# port. The next arm's own relay then dies with EADDRINUSE, and because a worker's startup
# check only confirms SOMETHING answers on the port, never which relay it is, that arm's
# worker silently attaches to the STALE relay from the PREVIOUS arm instead -- the same
# "silently wrong data" failure METAL-RUNBOOK.md section 3a already documents for a leaked
# relay across separate invocations, except this is within a single e11-density.sh run,
# between its own two arms. Verified against the port with ss, same as the runbook's own
# manual cleanup recipe -- never against a process name or a captured PID.
kill_relay_by_port() {
  local port="$1" pid
  # shellcheck disable=SC2034 # loop variable is the retry count itself, not read
  for tries in 1 2 3 4 5 6 7 8 9 10; do
    # sleep FIRST, not after the kill below: both call sites send SIGTERM to
    # E11_RELAY_PID just before this runs, and without a grace window here every
    # teardown escalates straight to SIGKILL before that SIGTERM has had a chance,
    # which can truncate the relay log mid-write (see wait_for_relay_port, which
    # leans on that log as its own failure evidence).
    sleep 0.5
    pid="$(ss -ltnp "sport = :${port}" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)"
    [ -z "$pid" ] && return 0
    kill -9 "$pid" 2>/dev/null
  done
  if [ -n "${E11_IN_CLEANUP:-}" ]; then
    log "port $port still held by pid $pid after 10 kill attempts - continuing best-effort teardown (see kill_relay_by_port's comment)"
    return 1
  fi
  die "port $port is still held by pid $pid after 10 kill attempts - the next arm's relay would bind onto a stale listener or fail with EADDRINUSE (see kill_relay_by_port's comment)"
}

# start_redis_loopback publishes this driver's scratch redis on LOOPBACK ONLY, and is
# the single place either arm starts one (both arms had the same `docker run` line).
#
# It was `-p "${PORT}:6379"`, which binds 0.0.0.0. On the documented rig -- an EC2
# m8i.xlarge with a public interface, running microvm-worker as root -- that publishes
# an UNAUTHENTICATED redis to the internet, and an open redis is a standard
# host-takeover path: CONFIG SET dir + dbfilename, then write an authorized_keys or a
# cron file. Nothing outside this host needs to reach a benchmark's scratch redis: the
# relay and the worker both connect over 127.0.0.1 (see REDIS_URL below). `--save ''`
# additionally disables RDB snapshots, so the container writes no dump file at all.
start_redis_loopback() {
  local arm="$1"
  log "$arm: starting redis on 127.0.0.1:$E11_REDIS_PORT (loopback only)"
  docker run --rm -d -p "127.0.0.1:${E11_REDIS_PORT}:6379" --name "sh-e11-redis-$$" \
    "$E11_REDIS_IMAGE" --save '' >/dev/null ||
    die "could not start the scratch redis on 127.0.0.1:$E11_REDIS_PORT for the $arm arm - the relay has nowhere to publish its presence record, so every Exec in this arm would fail for a reason that has nothing to do with density"
}

start_container_stack() {
  [ "$E11_START_STACK" = "1" ] || {
    log "container stack: SH_E11_START_STACK=0, reusing an already-running stack"
    return 0
  }
  # LOOPBACK ONLY -- see start_redis_loopback's own comment for why 0.0.0.0 is a
  # host-takeover path on the documented rig.
  start_redis_loopback container

  log "container: starting the relay on :$E11_RELAY_PORT"
  (
    cd "$REPO_ROOT" &&
      SH_RELAY_TOKEN="$E11_RELAY_TOKEN" SH_RELAY_PORT="$E11_RELAY_PORT" \
        REDIS_URL="redis://127.0.0.1:${E11_REDIS_PORT}" \
        pnpm --filter @sh/sandbox-relay start >"$RESULTS/e11-container-relay.log" 2>&1 &
    echo $! >"$RESULTS/.e11-relay.pid"
  )
  E11_RELAY_PID="$(cat "$RESULTS/.e11-relay.pid" 2>/dev/null || echo "")"
  wait_for_relay_port "$E11_RELAY_PORT" "$RESULTS/e11-container-relay.log" "the container arm's sandbox-relay"

  E11_WORKER_BIN="$RESULTS/.e11-container-worker-bin"
  log "container: building the worker binary"
  (cd "$REMOTE_WORKER_DIR" && go build -o "$E11_WORKER_BIN" ./cmd/worker) ||
    die "go build ./cmd/worker failed - the container arm has nothing to drive, so every Exec would time a missing binary rather than a container baseline"

  log "container: starting the worker"
  SANDBOX_ID="e11-container" RELAY_ADDR="localhost:${E11_RELAY_PORT}" \
    SANDBOX_TOKEN="$E11_RELAY_TOKEN" \
    "$E11_WORKER_BIN" >"$RESULTS/e11-container-worker.log" 2>&1 &
  E11_WORKER_PID="$!"
  wait_for_worker_attached "$RESULTS/e11-container-worker.log" "the container arm's worker"
}

stop_container_stack() {
  [ "$E11_START_STACK" = "1" ] || return 0
  # ${VAR:-} because these run from the EXIT trap too, which can fire before either is
  # assigned (build-snapshot.sh's cleanup_on_exit documents that exact failure).
  [ -n "${E11_WORKER_PID:-}" ] && kill "${E11_WORKER_PID:-}" 2>/dev/null
  [ -n "${E11_RELAY_PID:-}" ] && kill "${E11_RELAY_PID:-}" 2>/dev/null
  kill_relay_by_port "$E11_RELAY_PORT"
  docker rm -f "sh-e11-redis-$$" >/dev/null 2>&1 || true
  E11_WORKER_PID=""
  E11_RELAY_PID=""
  return 0
}

# start_microvm_stack starts one fresh microvm-worker process per (D, GuestRAMBytes)
# slice -- both are startup-fixed config (vmpool.Config), so a new slice needs a new
# process, not a running one reconfigured. SH_MAX_RUNS is sized to the largest
# active-runs rung so the sweep's own ladder never trips the MaxRuns backstop and
# gets misread as a VM-tier ceiling (spec section 7.3's lease-saturation metric row
# makes the analogous point one tier up).
start_microvm_stack() {
  local d="$1" ram_mb="$2" max_c="$3"
  [ "$E11_START_STACK" = "1" ] || {
    log "microvm stack: SH_E11_START_STACK=0, reusing an already-running stack"
    return 0
  }
  start_redis_loopback microvm

  log "microvm: starting the relay on :$E11_RELAY_PORT"
  (
    cd "$REPO_ROOT" &&
      SH_RELAY_TOKEN="$E11_RELAY_TOKEN" SH_RELAY_PORT="$E11_RELAY_PORT" \
        REDIS_URL="redis://127.0.0.1:${E11_REDIS_PORT}" \
        pnpm --filter @sh/sandbox-relay start >"$RESULTS/e11-microvm-relay-d${d}-ram${ram_mb}.log" 2>&1 &
    echo $! >"$RESULTS/.e11-relay.pid"
  )
  E11_RELAY_PID="$(cat "$RESULTS/.e11-relay.pid" 2>/dev/null || echo "")"
  wait_for_relay_port "$E11_RELAY_PORT" "$RESULTS/e11-microvm-relay-d${d}-ram${ram_mb}.log" "the microvm arm's sandbox-relay"

  E11_WORKER_BIN="$RESULTS/.e11-microvm-worker-bin"
  log "microvm: building the worker binary"
  (cd "$REMOTE_WORKER_DIR" && go build -o "$E11_WORKER_BIN" ./cmd/microvm-worker) ||
    die "go build ./cmd/microvm-worker failed - the microvm arm has nothing to drive, so every Exec would time a missing binary rather than a density ceiling"

  log "microvm: starting the worker (D=$d guest=${ram_mb}MiB)"
  SH_VMM=firecracker SH_STANDBY_DEPTH="$d" SH_GUEST_RAM_MB="$ram_mb" \
    SH_MAX_RUNS=$((max_c + d + 2)) SH_MAX_COMMITTED_MB="$MAX_COMMITTED_MB" \
    SH_SNAPSHOT_DIR="$SNAPSHOT_DIR" SH_SNAPSHOT_IMAGE="${SH_SNAPSHOT_IMAGE:-default}" \
    SH_WORKSPACE_ROOT="$WORKSPACE_ROOT" \
    SANDBOX_ID="e11-microvm-d${d}-ram${ram_mb}" RELAY_ADDR="localhost:${E11_RELAY_PORT}" \
    SANDBOX_TOKEN="$E11_RELAY_TOKEN" \
    "$E11_WORKER_BIN" >"$RESULTS/e11-microvm-worker-d${d}-ram${ram_mb}.log" 2>&1 &
  E11_WORKER_PID="$!"
  wait_for_worker_attached "$RESULTS/e11-microvm-worker-d${d}-ram${ram_mb}.log" "the microvm arm's worker (D=$d guest=${ram_mb}MiB)"
}

stop_microvm_stack() {
  [ "$E11_START_STACK" = "1" ] || return 0
  # ${VAR:-} because these run from the EXIT trap too, which can fire before either is
  # assigned (build-snapshot.sh's cleanup_on_exit documents that exact failure).
  [ -n "${E11_WORKER_PID:-}" ] && kill "${E11_WORKER_PID:-}" 2>/dev/null
  [ -n "${E11_RELAY_PID:-}" ] && kill "${E11_RELAY_PID:-}" 2>/dev/null
  kill_relay_by_port "$E11_RELAY_PORT"
  docker rm -f "sh-e11-redis-$$" >/dev/null 2>&1 || true
  E11_WORKER_PID=""
  E11_RELAY_PID=""
  return 0
}

# start_null_stack starts ONLY the null-responder (issue #291 section 4). No redis, no relay,
# no worker, no VMM: the control arm exists to measure what the DRIVER costs, so anything else
# left in the path would be measured along with it. That is also why this arm reuses neither
# E11_RELAY_PORT nor start_redis_loopback.
#
# One known gap in that isolation (issue #291 item 3): the null-responder answers every Exec
# with a single End event and no Chunk, so grpcurl on this arm never decodes a chunk-carrying
# stream. Real Execs for mix commands that produce stdout DO decode one or more Chunk events
# per call on the container/microvm arms. That decode cost is part of "what the driver costs"
# too, and this arm doesn't pay it -- so driver-control is a STRICT LOWER BOUND on driver-only
# cost, and subtracting it over-attributes some residue to the backend rather than the driver,
# the same direction of error as the artifact this branch exists to fix, at reduced magnitude.
# Recorded in every rung's proxyLimitations under 'driverControlChunkDecode'. Deliberately NOT
# fixed by making the responder emit chunks: that would change what this control arm measures
# mid-branch, and is out of scope here.
start_null_stack() {
  [ "$E11_START_STACK" = "1" ] || {
    log "driver-control stack: SH_E11_START_STACK=0, reusing an already-running null-responder"
    return 0
  }
  E11_NULL_BIN="$RESULTS/.e11-null-responder-bin"
  log "driver-control: building the null-responder"
  (cd "$REMOTE_WORKER_DIR" && go build -o "$E11_NULL_BIN" ./cmd/null-responder) ||
    die "go build ./cmd/null-responder failed - the driver-control arm has nothing to drive, so every Exec would time a missing binary rather than the driver's own overhead"

  log "driver-control: starting the null-responder on 127.0.0.1:$NULL_RESPONDER_PORT"
  "$E11_NULL_BIN" -listen "127.0.0.1:${NULL_RESPONDER_PORT}" \
    >"$RESULTS/e11-driver-control-responder.log" 2>&1 &
  E11_NULL_PID="$!"
  wait_for_relay_port "$NULL_RESPONDER_PORT" "$RESULTS/e11-driver-control-responder.log" \
    "the driver-control arm's null-responder"
}

stop_null_stack() {
  [ "$E11_START_STACK" = "1" ] || return 0
  # ${VAR:-} because this runs from the EXIT trap too, which can fire before it is assigned.
  [ -n "${E11_NULL_PID:-}" ] && kill "${E11_NULL_PID:-}" 2>/dev/null
  E11_NULL_PID=""
  return 0
}

# build_exec_driver compiles the Go Exec client ONCE per run, when it is the selected client.
#
# A no-op on the reference path: a grpcurl run must not fail over ./cmd/exec-driver not
# compiling, because it never invokes it. `go` is already an unconditional require_tool in
# preflight (every arm builds some binary), so this adds no new tool requirement.
build_exec_driver() {
  [ "$EXEC_CLIENT" = "go" ] || return 0
  log "exec-driver: building the persistent-connection Go Exec client (SH_E11_EXEC_CLIENT=go, issue #294)"
  (cd "$REMOTE_WORKER_DIR" && go build -o "$E11_EXEC_DRIVER_BIN" ./cmd/exec-driver) ||
    die "go build ./cmd/exec-driver failed - SH_E11_EXEC_CLIENT=go has no client to drive, so every rung would time a missing binary rather than an Exec"
}

# ---------------------------------------------------------------------------
# run_density_rung: THE per-rung driver. Called identically for all three arms --
# container, microvm, and driver-control (only sandbox_id, relay_port, and whether
# workspace_key is empty differ at the CALL SITE, in main() below) -- this is what
# makes "every arm driven by the same code path" true structurally rather than by
# claim.
#
# Writes one RungSample-shaped JSON object (matching
# experiments/src/microvm-density.ts's RungSample interface field-for-field) to
# out_json_path.
# ---------------------------------------------------------------------------
run_density_rung() {
  local arm="$1" d="$2" ram_mb="$3" c="$4" sandbox_id="$5" relay_port="$6" out_json_path="$7"
  log "rung: arm=$arm D=$d guest=${ram_mb}MiB c=$c"

  # Before issuing a single Exec: is the relay STILL there? See assert_relay_alive for the
  # run this cost.
  # The log name differs per arm, matching where each arm's server writes. assert_relay_alive
  # tails it, so a wrong path here costs the operator the one message that says what died.
  local relay_log="$RESULTS/e11-container-relay.log"
  case "$arm" in
  microvm) relay_log="$RESULTS/e11-microvm-relay-d${d}-ram${ram_mb}.log" ;;
  driver-control) relay_log="$RESULTS/e11-driver-control-responder.log" ;;
  esac
  assert_relay_alive "$relay_port" "$relay_log" "the $arm arm's sandbox-relay"

  # Every temp path is under $E11_TMPDIR, named for the rung rather than mktemp-random, so
  # the EXIT trap reclaims all of them however this rung ends (review 4001908613).
  local slot_dir converge_file rung_tag
  rung_tag="${arm}-d${d}-ram${ram_mb}-c${c}"
  slot_dir="$E11_TMPDIR/slots-$rung_tag"
  mkdir -p "$slot_dir"
  converge_file="$E11_TMPDIR/converge-$rung_tag"
  : >"$converge_file"

  # ---------------------------------------------------------------------------
  # PHASE 1: converge, OUTSIDE the timed window (issue #291 item 3).
  #
  # Every slot converges and exits; all are waited on. A non-zero exit still refuses the
  # rung, preserving the guarantee that a rung whose slots were not all measuring the same
  # thing is never recorded. Nothing here is inside wall_t0..wall_t1, so a slow git fetch can
  # no longer sit in the throughput denominator -- which is what made converge a throughput
  # ceiling on BOTH arms by construction.
  # ---------------------------------------------------------------------------
  local i pids=() pid
  for i in $(seq 1 "$c"); do
    (
      local run_id wskey cms cms_rc=0
      run_id="$(slot_run_id "$arm" "$d" "$ram_mb" "$c" "$i")"
      wskey="$(slot_workspace_key "$arm" "$run_id")"
      cms="$(converge_slot "$relay_port" "$sandbox_id" "$wskey" "$run_id" "$(slot_req_base "$i")")" || cms_rc=$?
      echo "$cms" >>"$converge_file"
      if [ "$cms_rc" -ne 0 ]; then
        echo "e11: slot $i: converge FAILED after ${cms}ms (see $RESULTS/e11-converge.log) - its workspace was never prepared, so its Exec timings would measure something else" >&2
        exit 1
      fi
    ) &
    pids+=("$!")
  done
  local converge_failures=0
  for pid in "${pids[@]}"; do
    wait "$pid" || converge_failures=$((converge_failures + 1))
  done
  [ "$converge_failures" -eq 0 ] ||
    die "rung arm=$arm d=$d ram=${ram_mb}MiB c=$c had $converge_failures of $c slot(s) fail before their timed loop (the reason is above, and in $RESULTS/e11-converge.log) - refusing to record a rung whose slots were not all measuring the same thing"

  # ---------------------------------------------------------------------------
  # Payload construction, still BEFORE timing starts (issue #291 item 2). This block MOVES
  # here from just above wall_t0, where Task 1 put it -- spec section 1: "pre-escape the 7 mix
  # commands and the slot's workspace_key once per slot, before timing starts". The
  # derivations now go through the same helpers phase 1 uses, so the two cannot drift.
  # ---------------------------------------------------------------------------
  local -a mix_json=() ws_json_by_slot=() ws_raw_by_slot=()
  local mix_expected_count
  mapfile -t mix_json < <(escaped_mix)
  [ "${#mix_json[@]}" -gt 0 ] ||
    die "rung arm=$arm d=$d ram=${ram_mb}MiB c=$c: escaped_mix produced no commands, so every slot would loop forever issuing no Execs"
  mix_expected_count="$(e11_tool_call_mix | wc -l)"
  [ "${#mix_json[@]}" -eq "$mix_expected_count" ] ||
    die "rung arm=$arm d=$d ram=${ram_mb}MiB c=$c: escaped_mix produced ${#mix_json[@]} command(s) but e11_tool_call_mix has $mix_expected_count -- a partial escape would silently shrink the mix every slot loops over"
  local run_id_i
  for i in $(seq 1 "$c"); do
    run_id_i="$(slot_run_id "$arm" "$d" "$ram_mb" "$c" "$i")"
    # ONE slot_workspace_key call, two consumers: the pre-escaped form the grpcurl path
    # interpolates, and the raw form the Go path's plan carries (json.dumps escapes it there).
    # Deriving it twice is how the two paths would drift into sending different keys.
    ws_raw_by_slot[i]="$(slot_workspace_key "$arm" "$run_id_i")"
    ws_json_by_slot[i]="$(json_escape "${ws_raw_by_slot[i]}")"
  done

  # The Go client's plan, written HERE -- before wall_t0 -- so nothing it costs lands inside the
  # timed window (issue #294, and the fork guard in tests/e11-density.test.sh asserts it). It
  # lives under $RESULTS, not $E11_TMPDIR: cleanup_on_exit rm -rf's $E11_TMPDIR on every exit,
  # including a refused rung's die, so a plan written there would not survive to be read -- only
  # $RESULTS (never cleaned) actually makes it the artifact an operator can read after a refusal.
  local plan_file="$RESULTS/plan-$rung_tag.json"
  if [ "$EXEC_CLIENT" = "go" ]; then
    local -a plan_argv=()
    local plan_cmd
    while IFS= read -r plan_cmd; do plan_argv+=("$plan_cmd"); done < <(e11_tool_call_mix)
    for i in $(seq 1 "$c"); do
      plan_argv+=("$(slot_req_base "$i")" "${ws_raw_by_slot[i]}" "$slot_dir/slot-$i.times" "$slot_dir/slot-$i.err")
    done
    # 30 is grpc_exec_record's own timeout_s, so both clients put the SAME Exec deadline on the
    # wire; tests/e11-density.test.sh reads both out of this file and asserts they match.
    write_rung_plan "$plan_file" "localhost:${relay_port}" "$sandbox_id" \
      "$ITERS_PER_SLOT" "$WARMUP_PER_SLOT" 30 "$EXEC_MAX_TIME_S" \
      "$mix_expected_count" "$c" "${plan_argv[@]}"
    # A header BEFORE wall_t0, so it costs nothing inside the timed window: $RESULTS/e11-exec-driver.log
    # is opened with >> and nothing ever truncates it, so every rung of every run appends untagged --
    # and the Go refusal below points the operator at exactly this file.
    printf '== %s\n' "$rung_tag" >>"$RESULTS/e11-exec-driver.log"
  fi

  # ---------------------------------------------------------------------------
  # PHASE 2: the timed Exec loop, and nothing else.
  # ---------------------------------------------------------------------------
  local sampler_file="$E11_TMPDIR/sampler-$rung_tag" sampler_stop="$E11_TMPDIR/sampler-stop-$rung_tag"
  : >"$sampler_file"
  rm -f "$sampler_stop"
  local wall_t0 wall_t1
  wall_t0="$(date +%s%N)"
  # The sampler brackets EXACTLY this window (issue #291 item 1). It is started after
  # wall_t0 and reaped after wall_t1, and the converge barrier above is what makes that
  # honest: with converge still inside the window, the git fetch's CPU would land in this
  # mean and a fresh artifact would have been built. sampler_file/sampler_stop are set up
  # (and any stale sampler_stop removed) BEFORE wall_t0 is stamped, so that bookkeeping
  # never lands inside the timed window either.
  host_sampler_loop "$sampler_file" "$sampler_stop" &
  E11_SAMPLER_PID="$!"
  pids=()
  # ONE process for the whole rung on the Go path (issue #294), c subshells on the grpcurl path.
  #
  # Both branches push onto the same pids array and are reaped by the same wait loop below, so
  # the guarantee that follows -- a rung whose slots were not all measuring the same thing is
  # never recorded -- holds identically for both.
  #
  # The grpcurl branch is UNCHANGED. It is the reference the Go client is compared against, so
  # it must not be tidied, rewrapped or "improved" while the comparison is outstanding.
  if [ "$EXEC_CLIENT" = "go" ]; then
    "$E11_EXEC_DRIVER_BIN" --plan "$plan_file" >>"$RESULTS/e11-exec-driver.log" 2>&1 &
    pids+=("$!")
  else
    for ((i = 1; i <= c; i++)); do
      (
        # No run_id or workspace_key derivation in here: phase 2 needs only the pre-escaped key
        # and the req_id base, so nothing that forks happens inside the timed window.
        local req_base req
        req_base="$(slot_req_base "$i")"
        req="$req_base"

        local times_file="$slot_dir/slot-$i.times" err_log="$slot_dir/slot-$i.err"
        # Pre-escaped above, before wall_t0. Parameter expansion, not a command substitution:
        # `local x="$(...)"` would trip SC2155, which is a WARNING and so a lint failure here.
        local ws_json="${ws_json_by_slot[$i]}"
        : >"$times_file"
        : >"$err_log"
        # A shell counter, not `wc -l` twice per Exec: the timed loop is this file's only
        # writer, so the count is known without reading it back. `for mi in` over the array
        # pre-escaped above also removes the process-substitution subshell the inner
        # `while read` re-spawned on every pass over the mix.
        local want=$((ITERS_PER_SLOT + WARMUP_PER_SLOT)) issued=0 mi
        while [ "$issued" -lt "$want" ]; do
          for mi in "${!mix_json[@]}"; do
            req=$((req + 1))
            grpc_exec_record "$relay_port" "$sandbox_id" "$ws_json" "${mix_json[$mi]}" "$req" "$times_file" "$err_log"
            issued=$((issued + 1))
            [ "$issued" -ge "$want" ] && break
          done
        done
      ) &
      pids+=("$!")
    done
  fi
  local exec_failures=0
  for pid in "${pids[@]}"; do
    wait "$pid" || exec_failures=$((exec_failures + 1))
  done
  wall_t1="$(date +%s%N)"
  : >"$sampler_stop"
  wait "$E11_SAMPLER_PID" 2>/dev/null || true
  E11_SAMPLER_PID=""
  if [ "$exec_failures" -ne 0 ]; then
    # The message differs because the FAILURE differs. One Go process drives all c slots, so a
    # non-zero exit says nothing about how many slots got timings -- it says the rung has none
    # that can be trusted. Reporting "1 of 8 slot(s) failed" there would understate it.
    if [ "$EXEC_CLIENT" = "go" ]; then
      die "rung arm=$arm d=$d ram=${ram_mb}MiB c=$c: the Go exec-driver exited non-zero (see $RESULTS/e11-exec-driver.log) - one process drives all $c slots, so a non-zero exit means no slot's timings can be trusted; refusing to record the rung"
    fi
    die "rung arm=$arm d=$d ram=${ram_mb}MiB c=$c had $exec_failures of $c slot(s) fail inside the timed loop - refusing to record a rung whose slots were not all measuring the same thing"
  fi
  local wall_s
  wall_s="$(require_numeric wallSeconds "$(awk -v ns=$((wall_t1 - wall_t0)) 'BEGIN{printf "%.4f", ns/1000000000.0}')")" ||
    die "rung arm=$arm c=$c could not measure its own wall time (see the refusal above) - throughput is derived from it, so there is nothing to record"

  # Aggregate every slot's steady-state (post-warmup) samples together.
  local all_times all_ok=0 all_total=0
  all_times="$E11_TMPDIR/all-times-$rung_tag"
  : >"$all_times"
  rm -f "${all_times}.ok"
  # `=()` is load-bearing, not style. Under `set -u`, `declare -A x` alone leaves x
  # DECLARED BUT UNSET, and `${#x[@]}` on it is an unbound-variable error -- verified on
  # this rig's bash 5.2.15. The only thing that ever assigned an element was the failure
  # branch below, so this rung's recorder crashed if and only if EVERY Exec succeeded:
  # the clean path was the broken one, and any run with a failure sailed past it. Found on
  # E11's first execution that got far enough to have a clean rung.
  declare -A cause_counts=()
  local f
  for f in "$slot_dir"/slot-*.times; do
    [ -e "$f" ] || continue
    tail -n "+$((WARMUP_PER_SLOT + 1))" "$f" | head -n "$ITERS_PER_SLOT" >>"$all_times"
  done
  while read -r ms status cause; do
    [ -n "$ms" ] || continue
    all_total=$((all_total + 1))
    if [ "$status" = "ok" ]; then
      all_ok=$((all_ok + 1))
      echo "$ms" >>"${all_times}.ok"
    else
      cause_counts["$cause"]=$(( ${cause_counts["$cause"]:-0} + 1 ))
    fi
  done <"$all_times"

  # execErrorsByCause is assembled HERE, ahead of the derived fields, rather than just
  # above the record writer where it used to be: the refusals below name these causes,
  # because "every Exec at this rung failed" is only actionable with the reason.
  local errors_json="{}"
  if [ "${#cause_counts[@]}" -gt 0 ]; then
    local parts=()
    local cause
    for cause in "${!cause_counts[@]}"; do
      parts+=("$(json_escape "$cause"):${cause_counts[$cause]}")
    done
    errors_json="{$(
      IFS=,
      echo "${parts[*]}"
    )}"
  fi

  # No `|| echo 0` on either percentile call (review 4001908597), and all five derived
  # fields go through require_numeric -- the guard that until now covered only the four
  # host signals, while p95, throughput, cold_rate, converge_p50 and wall_s reached the
  # record writer unvalidated.
  local p95 throughput cold_count=0
  p95="$(percentile 95 "${all_times}.ok")" ||
    die "rung arm=$arm d=$d ram=${ram_mb}MiB c=$c completed $all_ok successful Execs out of $all_total attempts, so it has no latency distribution to take a p95 of. Refusing to record p95Ms=0: that is not a fast rung, it is an absent measurement, and detectKnee would read it as the healthiest point in the ladder. Error causes: $errors_json - see the worker/relay logs in $RESULTS."
  p95="$(require_numeric p95Ms "$p95")" ||
    die "rung arm=$arm c=$c: p95 failed validation (see the refusal above)"
  throughput="$(require_numeric throughput "$(awk -v n="$all_ok" -v s="$wall_s" 'BEGIN{ if (s>0) printf "%.4f", n/s; else print 0 }')")" ||
    die "rung arm=$arm c=$c: throughput failed validation (see the refusal above)"
  # `.ok` is guaranteed non-empty here: the p95 refusal above is exactly the case where it
  # is not, so this needs no existence guard of its own.
  cold_count="$(awk -v t="$COLD_LATENCY_MS" '$1>=t{c++} END{print c+0}' "${all_times}.ok")"
  local cold_rate
  cold_rate="$(require_numeric coldAcquireRate "$(awk -v c="$cold_count" -v n="$all_total" 'BEGIN{ if (n>0) printf "%.4f", c/n; else print 0 }')")" ||
    die "rung arm=$arm c=$c: coldAcquireRate failed validation (see the refusal above)"

  local converge_p50
  converge_p50="$(percentile 50 "$converge_file")" ||
    die "rung arm=$arm d=$d ram=${ram_mb}MiB c=$c recorded no converge timings at all ($converge_file is empty), so section 4.5's converge cost -- which spec section 7.5 requires be timed SEPARATELY from the Exec mix -- has no value for this rung. Refusing to record 0, which would read as a free fetch."
  converge_p50="$(require_numeric convergeMsP50 "$converge_p50")" ||
    die "rung arm=$arm c=$c: convergeMsP50 failed validation (see the refusal above)"

  # ---------------------------------------------------------------------------
  # The four host signals, now sampled DURING the window (issue #291 item 1).
  #
  # hostCpuFraction becomes the MEAN. That is not "mean is more representative": with today's
  # idle samples both firstCrossing('cpu') and firstCrossing('memory') are Infinity and
  # scorePrediction1 reads inconclusive, but if CPU crosses 0.9 anywhere while memory and
  # process-count never do, `memOrProcAt <= cpuAt` is false and sealed prediction 1 flips
  # straight to FALSIFIED. Scoring that off a single one-second peak -- a GC pause, a
  # drop_caches, an unrelated process on a shared box -- would be the same class of error as
  # the artifact being fixed, pointed the other way. The mean matches what crosses('cpu')
  # asserts: THIS RUNG WAS CPU-SATURATED, not "this rung once touched saturation". Nothing is
  # lost, because the peak is recorded beside it.
  # ---------------------------------------------------------------------------
  local cpu_samples cpu_mean cpu_peak cpu_min cores_busy ncpu
  local mem_mean mem_min pss_mean pss_peak pss_samples proc_mean proc_peak proc_samples
  local pss_refused_ticks
  cpu_samples="$(require_numeric hostCpuSamples "$(sampler_field "$sampler_file" 1 count)")" ||
    die "rung arm=$arm c=$c could not count its own host samples (see the refusal above)"
  [ "$cpu_samples" -gt 0 ] ||
    die "rung arm=$arm d=$d ram=${ram_mb}MiB c=$c produced ZERO host samples over its timed window ($sampler_file is empty), so it has no under-load hostCpuFraction, memAvailableBytes, pssBytes or processCount at all. Refusing to backfill from the post-load snapshot: that idle reading IS the defect issue #291 item 1 is about, and crosses('cpu') can never fire on one. The window was shorter than ${SAMPLE_MIN_TICK_MS}ms - lower SH_E11_SAMPLE_INTERVAL_MS, SH_E11_SAMPLE_MIN_TICK_MS and SH_E11_SAMPLE_SLICE_MS (the tick floor is SAMPLE_SLICE_MS, currently ${SAMPLE_SLICE_MS}ms, because slices_per_tick is SAMPLE_INTERVAL_MS/SAMPLE_SLICE_MS floored at 1). Raising SH_E11_ITERS_PER_SLOT also works for a SINGLE ladder, but NOT when you are comparing two clients: both arms must issue the same Exec count per slot to stay comparable, so fix the cadence instead."
  # A thin rung is legitimate (a fast arm at low c) and is NOT refused -- but it must not pass
  # unremarked, because hostCpuSamples is easy to miss in a 30-field record and a 1-2 sample mean
  # cannot support a saturation verdict. Warn at run time, where the operator is actually looking.
  if [ "$cpu_samples" -lt 5 ]; then
    log "WARNING: rung arm=$arm c=$c produced only $cpu_samples host sample(s) over its timed window - its hostCpuFraction is a mean of $cpu_samples tick(s) and must NOT be used to score a CPU saturation verdict. Raise SH_E11_ITERS_PER_SLOT (currently $ITERS_PER_SLOT) or lower SH_E11_SAMPLE_INTERVAL_MS (currently ${SAMPLE_INTERVAL_MS}ms) so the window spans >=10 ticks."
  fi
  cpu_mean="$(require_numeric hostCpuFraction "$(sampler_field "$sampler_file" 1 mean '%.4f')")" ||
    die "rung arm=$arm c=$c: the sampled hostCpuFraction mean failed validation (see above)"
  cpu_peak="$(require_numeric hostCpuFractionPeak "$(sampler_field "$sampler_file" 1 peak '%.4f')")" ||
    die "rung arm=$arm c=$c: hostCpuFractionPeak failed validation (see above)"
  cpu_min="$(require_numeric hostCpuFractionMin "$(sampler_field "$sampler_file" 1 min '%.4f')")" ||
    die "rung arm=$arm c=$c: hostCpuFractionMin failed validation (see above)"
  ncpu="$(host_cpu_count)"
  # coresBusy, because "0.043 cores busy" is a number a human can act on where 0.0006 is not
  # -- and 0.0006 on a 72-cpu host next to ~370 process creations a second is precisely the
  # self-falsifying pair that exposed this bug.
  cores_busy="$(require_numeric coresBusy "$(awk -v m="$cpu_mean" -v n="$ncpu" 'BEGIN{printf "%.4f", m*n}')")" ||
    die "rung arm=$arm c=$c: coresBusy failed validation (see above)"
  mem_mean="$(require_numeric memAvailableBytes "$(sampler_field "$sampler_file" 2 mean '%.0f')")" ||
    die "rung arm=$arm c=$c: the sampled memAvailableBytes mean failed validation (see above)"
  mem_min="$(require_numeric memAvailableBytesMin "$(sampler_field "$sampler_file" 2 min '%.0f')")" ||
    die "rung arm=$arm c=$c: memAvailableBytesMin failed validation (see above)"
  pss_samples="$(require_numeric pssSamples "$(sampler_field "$sampler_file" 3 count)")" ||
    die "rung arm=$arm c=$c: pssSamples failed validation (see above)"
  # pssRefusedTicks (issue #291 item 4): a low-cadence tick where pss_bytes_for_pids DIED on
  # an unreadable smaps_rollup for a still-live pid (spec section 7.3's boxed warning) records
  # "refused" in this column, not "-". Without this counter that refusal was indistinguishable
  # from an ordinary un-sampled tick -- it just vanished from pssSamples along with the record
  # of WHY. sampler_marker_count reads the sampler file directly, so a rung whose window ends
  # with the sampler already reaped still gets an accurate count.
  pss_refused_ticks="$(require_numeric pssRefusedTicks "$(sampler_marker_count "$sampler_file" 3 refused)")" ||
    die "rung arm=$arm c=$c: pssRefusedTicks failed validation (see above)"
  pss_mean="$(require_numeric pssBytes "$(sampler_field "$sampler_file" 3 mean '%.0f')")" ||
    die "rung arm=$arm d=$d ram=${ram_mb}MiB c=$c sampled $cpu_samples host ticks but not one carried a PSS reading, so Sigma PSS -- the one number spec section 7.3 insists must not be wrong -- has no under-load value for this rung. SH_E11_SAMPLE_LOW_EVERY is ${SAMPLE_LOW_EVERY}; tick 1 always carries it, so an empty column means pss_bytes_for_pids refused on every low-cadence tick ($pss_refused_ticks recorded as 'refused' -- see its own refusals above) or none ever ran."
  pss_peak="$(require_numeric pssBytesPeak "$(sampler_field "$sampler_file" 3 peak '%.0f')")" ||
    die "rung arm=$arm c=$c: pssBytesPeak failed validation (see above)"
  proc_samples="$(require_numeric processCountSamples "$(sampler_field "$sampler_file" 4 count)")" ||
    die "rung arm=$arm c=$c: processCountSamples failed validation (see above)"
  proc_mean="$(require_numeric processCount "$(sampler_field "$sampler_file" 4 mean '%.0f')")" ||
    die "rung arm=$arm c=$c: the sampled processCount mean failed validation (see above)"
  proc_peak="$(require_numeric processCountPeak "$(sampler_field "$sampler_file" 4 peak '%.0f')")" ||
    die "rung arm=$arm c=$c: processCountPeak failed validation (see above)"

  # The POST-LOAD snapshot is KEPT, under explicitly different names. Its refusals are still
  # the ones that matter most: require_vmm=1 on the microvm arm with D >= 1 means at least one
  # standby VMM is necessarily still resident (StandbyIdle is 90s), so zero matching processes
  # means the sampler is looking in the wrong place, not that memory is free. Keeping it under
  # postLoad* names is what makes it impossible for an idle reading to pass as an under-load
  # one ever again.
  local require_vmm=0
  if [ "$arm" = "microvm" ] && [ "$d" != "0" ]; then
    require_vmm=1
  fi
  local signals post_pss post_mem post_cpu post_proc
  signals="$(host_signals_snapshot "$require_vmm")" ||
    die "post-load host signal snapshot failed for rung arm=$arm c=$c (see the refusal above) - refusing to write a rung record from signals that could not be sampled"
  post_pss="$(python3 -c "import json,sys; print(json.load(sys.stdin)['pssBytes'])" <<<"$signals")"
  post_mem="$(python3 -c "import json,sys; print(json.load(sys.stdin)['memAvailableBytes'])" <<<"$signals")"
  post_cpu="$(python3 -c "import json,sys; print(json.load(sys.stdin)['hostCpuFraction'])" <<<"$signals")"
  post_proc="$(python3 -c "import json,sys; print(json.load(sys.stdin)['processCount'])" <<<"$signals")"

  # standbysResident: disclosed proxy (see header). idleStandbyResidency + reclaim
  # convergence: poll the same process-count proxy after every slot has finished,
  # up to StandbyIdle + 2*ReclaimScanInterval (spec section 7.4 prediction 5),
  # sampling at ReclaimScanInterval. Skipped for the container arm, which has no
  # standby concept at all -- recorded as 0 rather than waited-for.
  local standbys_resident=0 idle_residency=0 reclaim_converge_s=0
  standbys_resident=$((proc_mean > c ? proc_mean - c : 0))
  if [ "$arm" = "microvm" ]; then
    local waited=0 budget=135 interval=23 last_count="$post_proc" idle_snapshot
    while [ "$waited" -lt "$budget" ]; do
      sleep "$interval"
      waited=$((waited + interval))
      # Captured to its own variable first: nesting host_signals_snapshot inside the
      # python command substitution would discard its exit status along with any
      # refusal it made, which is the same subshell-swallows-die shape as above.
      # NOT require_vmm=1: this poll exists to watch standbys BE RECLAIMED (spec section
      # 7.4 prediction 5), so reaching zero VMM processes here is the predicted outcome,
      # not a sampling failure.
      idle_snapshot="$(host_signals_snapshot 0)" ||
        die "host signal snapshot failed while polling idle standby residency for rung arm=$arm c=$c (see the refusal above)"
      last_count="$(python3 -c "import json,sys; print(json.load(sys.stdin)['processCount'])" <<<"$idle_snapshot")"
      # BREAK when the standbys are actually gone. Without this the loop always ran its full
      # budget, so reclaim_converge_s below was the CONSTANT 138 for every microvm rung no
      # matter when reclamation finished -- written into the record as reclaimConvergenceS as
      # though it were observed. Spec 7.4 prediction 5 is precisely a claim about how long
      # that takes, so a constant made it unmeasurable rather than merely imprecise. It also
      # burned the whole budget per rung (~9 minutes across the default metal ladder) to
      # learn nothing.
      #
      # processCount is the disclosed proxy for standbys (see the header): at this point every
      # slot has finished, so a count at or below c means nothing is parked beyond the
      # in-flight set, which is the convergence this is timing.
      if [ "$last_count" -le "$c" ]; then
        break
      fi
    done
    idle_residency="$last_count"
    reclaim_converge_s="$waited"
  fi

  # The two swept dimensions become PYTHON LITERALS in the writer below, so they go through
  # dimension_literal rather than straight into the interpolation -- see that function for
  # what a bare "-" did to every container rung (review 4001908573). Required on the
  # microvm arm, which cannot record a rung without the D and guest RAM it swept.
  local d_json ram_json required_dims=0
  [ "$arm" = "microvm" ] && required_dims=1
  d_json="$(dimension_literal standbyDepth "$d" "$required_dims")" ||
    die "rung arm=$arm c=$c cannot record standbyDepth (see the refusal above)"
  ram_json="$(dimension_literal guestRamMb "$ram_mb" "$required_dims")" ||
    die "rung arm=$arm c=$c cannot record guestRamMb (see the refusal above)"

  # Interpolated as python literals below, so they are computed here rather than inline.
  local exec_client_json driver_control_note exec_error_note
  exec_client_json="$(exec_client_label)"
  # The two proxyLimitations entries that DEPEND on which client ran. Both are written on both
  # paths -- a limitation that only appears on the path that does not have it is not a
  # disclosure. Neither string may contain an apostrophe: they are interpolated into
  # single-quoted python literals.
  driver_control_note="$(driver_control_note_for "$EXEC_CLIENT")"
  exec_error_note="$(exec_error_note_for "$EXEC_CLIENT")"

  python3 -c "
import json
rec = {
  'c': $c,
  'throughput': $throughput,
  'p95Ms': $p95,
  'coldAcquireRate': $cold_rate,
  'coldLatencyThresholdMs': $COLD_LATENCY_MS,
  # The four RungSample host signals, now sampled DURING the timed window (#291 item 1).
  # Same names, same place in the contract, under-load values.
  'hostCpuFraction': $cpu_mean,
  'memAvailableBytes': $mem_mean,
  'pssBytes': $pss_mean,
  'processCount': $proc_mean,
  # Extremes and sample counts, so a mean can always be checked against what it averaged.
  # hostCpuSamples exposes thin rungs: a mean of 2 samples deserves a visible caveat.
  'hostCpuFractionPeak': $cpu_peak,
  'hostCpuFractionMin': $cpu_min,
  'hostCpuSamples': $cpu_samples,
  'coresBusy': $cores_busy,
  'memAvailableBytesMin': $mem_min,
  'pssBytesPeak': $pss_peak,
  'pssSamples': $pss_samples,
  # A low-cadence tick that DID try to sample PSS but pss_bytes_for_pids died on an
  # unreadable smaps_rollup for a still-live pid (spec section 7.3's boxed warning). Counted
  # separately from pssSamples so a refusal is visible rather than indistinguishable from an
  # ordinary un-sampled tick (issue #291 item 4).
  'pssRefusedTicks': $pss_refused_ticks,
  'processCountPeak': $proc_peak,
  'processCountSamples': $proc_samples,
  # Old and new records both carry hostCpuFraction meaning different things; without this
  # marker someone compares them later and is misled by the fix itself.
  'samplingMode': 'in-rung-1hz-mean',
  # The retained post-load snapshot, explicitly named so an idle reading can never again
  # pass as an under-load one.
  'postLoadHostCpuFraction': $post_cpu,
  'postLoadMemAvailableBytes': $post_mem,
  'postLoadPssBytes': $post_pss,
  'postLoadProcessCount': $post_proc,
  'standbysResident': $standbys_resident,
  'idleStandbyResidency': $idle_residency,
  'leaseSaturations': 0,
  'execErrorsByCause': json.loads('''$errors_json'''),
  # Recorded, not part of the RungSample contract consumed by analyzeLadder, but
  # written alongside it so no context is lost between the raw JSON and the report.
  'arm': '$arm',
  'standbyDepth': $d_json,
  'guestRamMb': $ram_json,
  'runId': '$E11_RUN_ID',
  'substrate': '$SUBSTRATE',
  'repoCacheShape': '$REPO_CACHE_SHAPE',
  'convergeMsP50': $converge_p50,
  'reclaimConvergenceS': $reclaim_converge_s,
  'drivingModel': 'closed-loop-per-slot',
  # WHICH CLIENT issued the Execs these latencies came from (#294). Without it a go-driven
  # ladder and a grpcurl-driven one are indistinguishable JSON, and comparing them is the
  # entire reason the second client exists.
  'execClient': '$exec_client_json',
  'staticSettings': json.loads('$(static_settings_json)'),
  'proxyLimitations': {
    'leaseSaturations': 'always 0 - driver bypasses the harness lease layer entirely',
    'coldAcquireRate': 'latency-classification proxy (>= ${COLD_LATENCY_MS}ms), not the real replenishment signal - no stats endpoint exists',
    'standbysResident': 'proxy: max(processCount - c, 0) - no pool introspection endpoint exists',
    'pssBytesCadence': 'pssBytes and processCount are sampled every ${SAMPLE_LOW_EVERY}th sampler tick (and always tick 1), not every tick: pgrep plus an N-file smaps_rollup walk at 1 Hz perturbs the density ceiling being measured. crosses(memory) reads memAvailableBytes, which IS every tick, so the bound classification is unaffected; PSS feeds the narrative. See pssSamples and processCountSamples for the actual counts (#291).',
    'driverControlChunkDecode': '$driver_control_note',
    'execErrorStatus': '$exec_error_note',
  },
}
open('$out_json_path', 'w').write(json.dumps(rec, indent=2))
"
  # A rung that wrote no record FAILS LOUDLY (final review H2). This driver runs
  # `set -uo pipefail` without `set -e`, so the writer above dying -- of a SyntaxError
  # from an empty interpolation, a KeyError, anything -- did not abort or even warn: the
  # sweep continued to the next rung and did it again, and E11 could complete an entire
  # sweep having recorded nothing while exiting 0.
  #
  # `set -e` was considered and deliberately NOT adopted for this script: it has never
  # been run end to end, and it contains many intentional non-zero statuses (`grep -c`
  # with no match, `|| true`, `|| log`), so turning every one of them into an abort
  # mid-sweep would trade a silent no-data outcome for a loud partial-data one with no
  # test able to tell which statuses were load-bearing. This assertion is the targeted
  # form: it fires exactly when the thing that matters -- the record -- is missing, and
  # names the rung so the operator does not have to diff a directory listing to find out
  # which one.
  [ -s "$out_json_path" ] ||
    die "rung arm=$arm d=$d ram=${ram_mb}MiB c=$c wrote no record to $out_json_path - the record writer failed (its Python traceback is above). A sweep that completes having recorded nothing is the worst outcome for a benchmark, because it looks like success."
  rm -rf "$slot_dir" "$all_times" "${all_times}.ok" "$converge_file" "$sampler_file" "$sampler_stop"
}

# assemble_ladder collects every per-rung JSON file for one (arm, D, guest RAM)
# slice into a single JSON array, ascending by c, ready for analyzeLadder.
assemble_ladder() {
  local pattern="$1" out_path="$2" rc=0
  # Only THIS invocation's rungs. A record with no runId predates the stamp and is treated as
  # stale, which is the safe direction: it cannot be shown to belong to this run.
  python3 -c "
import glob, json, sys
run_id = '$E11_RUN_ID'
kept, skipped = [], []
for f in sorted(glob.glob('$pattern')):
    r = json.load(open(f))
    (kept if r.get('runId') == run_id else skipped).append((f, r))
if skipped:
    sys.stderr.write('e11: assemble_ladder SKIPPED %d stale rung record(s) not from this run (%s): %s\n'
                     % (len(skipped), run_id, ', '.join(f.split('/')[-1] for f, _ in skipped)))
if not kept:
    sys.stderr.write('e11: assemble_ladder found no rung records from this run matching $pattern - '
                     'refusing to write an empty or all-stale ladder to $out_path\n')
    sys.exit(1)
recs = [r for _, r in kept]
recs.sort(key=lambda r: r['c'])
open('$out_path', 'w').write(json.dumps(recs, indent=2))
"
  # The closing quote above MUST stay on its own line: extract_fn skips the span between
  # `  python3 -c "` and a bare `"` (Task 3 taught it to, because this file's record writer has a
  # column-0 `}` inside its python dict). Appending `|| die ...` to that line leaves the skip open,
  # so extraction swallows the rest of the function and the tests source a snippet without it.
  rc=$?
  [ "$rc" -eq 0 ] || die "assemble_ladder could not build $out_path from this run's rungs (see the refusal above) - a ladder mixing runs is worse than no ladder, because detectKnee re-scales every health decision off its c=1 baseline"
}

# analyze_slice invokes experiments/src/microvm-density.ts's analyzeLadder against
# one assembled ladder file and prints the report. Informational only -- this
# script never writes numbers into deploy/microvm/EXPERIMENTS.md itself (task-21
# scope: step 6 is structure-only, hardware-corrections F1).
# The import below says '.ts', NOT '.js'. Inside a compiled TypeScript file '.js' is the
# correct NodeNext specifier and tsx maps it to the .ts source -- but this is a "tsx -e" EVAL
# string, whose module lives at a synthetic <dir>/[eval] path, and that mapping does not
# apply there: resolution falls through to the CJS resolver and dies with "Cannot find
# module ./src/microvm-density.js". Reproduced on the rig (node 22) and on a dev machine
# (node 25), so it is not environment-specific.
#
# It went unnoticed because analyze_slice is deliberately called with "|| log": every ladder
# ran, the failure was one logged line, and no knee was ever computed -- and the knee is what
# sealed prediction 3 is ABOUT. Non-fatal was the right choice; silent was not.
#
# Keep prose out of the eval string itself: it is a bash double-quoted argument, so
# backticks in it are command substitution rather than markup.
analyze_slice() {
  local ladder_path="$1"
  (
    cd "$EXPERIMENTS_DIR" &&
      pnpm exec tsx -e "
        import { readFileSync } from 'node:fs';
        import { analyzeLadder } from './src/microvm-density.ts';
        const samples = JSON.parse(readFileSync(process.argv[1], 'utf8'));
        console.log(JSON.stringify(analyzeLadder(samples), null, 2));
      " "$ladder_path"
  )
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  preflight
  # After preflight, which validated EXEC_CLIENT and created $RESULTS.
  build_exec_driver
  log "arms: ${E11_ARMS[*]} (microvm is Firecracker only - hardware-corrections F5; driver-control is the null-responder, issue #291 section 4)"
  log "D values: ${D_VALUES[*]}   guest RAM (MiB): ${RAM_MB_VALUES[*]}   active runs: ${ACTIVE_RUNS[*]}"
  [ -n "$MODEL_STUB_CMD" ] || log "no SH_E11_MODEL_STUB_CMD set - driving the Exec mix directly (disclosed limitation, see header)"

  local max_c=1 c
  for c in "${ACTIVE_RUNS[@]}"; do
    [ "$c" -gt "$max_c" ] && max_c="$c"
  done

  local order first=1 arm
  order="$(shuffle_e11_arms)"
  while IFS= read -r arm; do
    [ -n "$arm" ] || continue
    if [ "$first" -eq 0 ]; then
      drop_caches
    fi
    first=0

    case "$arm" in
    container)
      start_container_stack
      for c in "${ACTIVE_RUNS[@]}"; do
        run_density_rung container - - "$c" "e11-container" "$E11_RELAY_PORT" \
          "$RESULTS/e11-rung-container-c${c}.json"
      done
      stop_container_stack
      assemble_ladder "$RESULTS/e11-rung-container-c*.json" "$RESULTS/e11-ladder-container.json"
      analyze_slice "$RESULTS/e11-ladder-container.json" || log "analyze_slice(container) failed - see output above"
      ;;
    driver-control)
      start_null_stack
      for c in "${ACTIVE_RUNS[@]}"; do
        run_density_rung driver-control - - "$c" "e11-driver-control" "$NULL_RESPONDER_PORT" \
          "$RESULTS/e11-rung-driver-control-c${c}.json"
      done
      stop_null_stack
      assemble_ladder "$RESULTS/e11-rung-driver-control-c*.json" "$RESULTS/e11-ladder-driver-control.json"
      # analyze_slice is SKIPPED here: analyzeLadder scores a ladder of COLD ACQUIRES against
      # sealed predictions about a VM pool, and this arm has no pool and no acquires, so its
      # verdicts would be noise attached to real prediction ids. The ladder file is still
      # assembled, because subtracting this arm from the other two at each c is the entire
      # purpose of the arm.
      log "driver-control: ladder assembled at $RESULTS/e11-ladder-driver-control.json (analyze_slice skipped - no pool and no cold acquires; subtract this arm from the others at each c to get the driver's own share)"
      ;;
    microvm)
      local d ram_mb
      for d in "${D_VALUES[@]}"; do
        for ram_mb in "${RAM_MB_VALUES[@]}"; do
          start_microvm_stack "$d" "$ram_mb" "$max_c"
          for c in "${ACTIVE_RUNS[@]}"; do
            run_density_rung microvm "$d" "$ram_mb" "$c" "e11-microvm-d${d}-ram${ram_mb}" "$E11_RELAY_PORT" \
              "$RESULTS/e11-rung-microvm-d${d}-ram${ram_mb}-c${c}.json"
          done
          stop_microvm_stack
          assemble_ladder "$RESULTS/e11-rung-microvm-d${d}-ram${ram_mb}-c*.json" \
            "$RESULTS/e11-ladder-microvm-d${d}-ram${ram_mb}.json"
          analyze_slice "$RESULTS/e11-ladder-microvm-d${d}-ram${ram_mb}.json" ||
            log "analyze_slice(microvm d=$d ram=$ram_mb) failed - see output above"
        done
      done
      ;;
    esac
  done <<<"$order"

  log "done. Per-slice ladders and analyses are in $RESULTS/e11-ladder-*.json"
}

# Allow this file to be sourced (for tests that extract individual functions)
# without invoking main.
if [ "${E11_DENSITY_SOURCE_ONLY:-0}" != "1" ]; then
  main "$@"
fi
