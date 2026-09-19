#!/usr/bin/env bash
# deploy/microvm/tests/e11-density.test.sh
#
# Cluster-free, KVM-free tests for e11-density.sh. Like e10-lifecycle.sh, the real
# script needs /dev/kvm, a real relay, real worker binaries and (per task-21
# hardware-corrections F1/F2) a rig this task is explicitly forbidden from driving
# a real sweep against -- so what can rot silently here is the CONTRACT: the exact
# properties the task brief's checklist requires of e11-density.sh (that brief is a
# build-time note, not committed; the properties themselves are asserted below),
# verbatim: "asserts: smaps_rollup is used and RSS is not; the ladder includes
# c=1; converge is timed separately; section 4.5's shape is recorded; the four
# idle settings are recorded and not swept; the driver is open-loop or declares
# the bias; and both arms are driven by the same code path."
#
# Each of those seven items gets its own section below, in the brief's order.
#
# Non-vacuousness pattern (matching e10-lifecycle.test.sh's own STOP/MANDATORY
# proof): a test for an absence must first prove the presence is reachable. The
# smaps_rollup section proves pss_bytes_for_pids CAN and DOES fail on an unreadable
# rollup for a still-alive pid (the presence), before asserting it never falls
# back to reading VmRSS to route around that failure (the absence).
#
# Functions are extracted from the real e11-density.sh source text (grep for the
# opening line, awk for the matching closing bare "}") and sourced in isolation --
# the same technique e10-lifecycle.test.sh and build-snapshot.test.sh use -- so
# these tests drive the REAL artifact, never a rewritten substitute.
#
# Run: bash deploy/microvm/tests/e11-density.test.sh

set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$DIR/e11-density.sh"
fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok: $1"; else
  echo "  FAIL: $1 (want '$3', got '$2')"
  fails=$((fails + 1))
fi; }

# extract_fn prints the source text of a top-level "name() { ... }" function
# (opening line "name() {" and closing bare "}") from $SCRIPT. A function's own embedded
# `python3 -c "..."` heredoc (see extract_record_writer below) can contain a dict literal
# whose closing brace sits at column 0, colliding with the bash-function-close convention
# this scans for -- so that whole span is skipped while looking for the real close.
extract_fn() {
  local name="$1" start end
  start=$(grep -n "^${name}() {" "$SCRIPT" | head -n1 | cut -d: -f1)
  [ -n "$start" ] || return 1
  end=$(awk -v s="$start" '
    NR<=s { next }
    !inpy && $0 == "  python3 -c \"" { inpy = 1; next }
    inpy && $0 == "\"" { inpy = 0; next }
    !inpy && /^}$/ { print NR; exit }
  ' "$SCRIPT")
  [ -n "$end" ] || return 1
  sed -n "${start},${end}p" "$SCRIPT"
}

# extract_fns prints several functions concatenated, in the order given, so a
# helper that calls another helper can be sourced together in one subshell.
extract_fns() {
  local name
  for name in "$@"; do
    extract_fn "$name" || return 1
    echo
  done
}

# ---------------------------------------------------------------------------
# Marker processes: how this suite gets a real, LIVE, DETERMINISTICALLY DISCOVERABLE pid
# for the PSS sampler to be pointed at.
#
# Every block below used to spawn `sh -c 'sleep 5' &` and match it with the pattern
# "sleep 5". That is where the ubuntu-24.04 CI failure came from, and it is a fixture bug,
# not a driver bug:
#
#   - Ubuntu's /bin/sh is dash, and dash does NOT exec the command in `sh -c CMD` -- it
#     FORKS a child. So `pgrep -f 'sleep 5'` returned TWO pids: the `sh -c sleep 5` wrapper
#     that `$!` names, and a `sleep 5` child. The fabricated proc tree covered only the
#     first, and a LIVE pid with no readable smaps_rollup is precisely what
#     pss_bytes_for_pids refuses to guess about (spec section 7.3's boxed warning) -- so the
#     snapshot refused, the acceptance assertion read "want 0, got 1", and json.load then
#     got an empty file. Confirmed by running this suite in an ubuntu:24.04 container:
#     `pid=2534 cmdline=[sh -c sleep 5]` alongside `pid=2536 cmdline=[sleep 5]`.
#   - bash, which is /bin/sh on macOS and on Amazon Linux 2023, execs instead, so there was
#     exactly one pid and the same fixture passed on both of those hosts.
#   - `kill "$!"` killed only the wrapper, orphaning the `sleep 5` child for the rest of its
#     five seconds -- where a later block matching the same pattern could pick it up.
#
# The replacement depends on no shell's exec/fork choice and on no host process: ONE
# process, no shell wrapper, and a token in its argv that nothing else on any host shares.
# Blocks then fabricate a rollup for EVERY pid discover_pids actually returns, so the
# fixture covers the real pid set instead of assuming what it will be.
marker_token() {
  printf '__e11_marker_%s_%s' "$$" "$1"
}

# spawn_marker_process starts one marker process and sets MARKER_PID. A plain assignment
# rather than a printed pid, so the process is this shell's own child and `wait` works.
# The 60s lifetime bounds the leak if the suite dies before stop_marker_process.
MARKER_PID=""
spawn_marker_process() {
  python3 -c 'import sys, time; time.sleep(int(sys.argv[1]))' 60 "$1" &
  MARKER_PID=$!
}

stop_marker_process() {
  [ -n "${1:-}" ] || return 0
  kill "$1" 2>/dev/null
  wait "$1" 2>/dev/null
  return 0
}

# discovered_pids_for prints the pids the REAL discover_pids (sourced from $1) returns for
# pattern $2, retrying until at least $3 of them appear. The retry is not politeness: a
# process that has not been scheduled yet would silently make a block assert things about an
# EMPTY pid set, which is the vacuous-test shape this suite exists to avoid.
discovered_pids_for() {
  local snippet="$1" pattern="$2" want="${3:-1}" tries=0 pids="" n=0
  while [ "$tries" -lt 25 ]; do
    tries=$((tries + 1))
    pids="$(
      # shellcheck disable=SC1090
      . "$snippet"
      discover_pids "$pattern"
    )"
    n="$(printf '%s\n' "$pids" | grep -c '[0-9]')"
    [ "$n" -lt "$want" ] || break
    sleep 0.2
  done
  printf '%s' "$pids"
}

# count_pids counts the pid lines in $1 (an empty list counts 0, not 1).
count_pids() {
  printf '%s\n' "$1" | grep -c '[0-9]'
}

# plant_rollups fabricates $3 kB of Pss for EVERY pid in $2, under fake proc root $1.
plant_rollups() {
  local root="$1" kb="$3" pid
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    mkdir -p "$root/$pid"
    printf 'Pss: %s kB\n' "$kb" >"$root/$pid/smaps_rollup"
  done <<<"$2"
}

echo "== the script exists, is executable, and is shellcheck-clean"
check "e11-density.sh present" "$([ -f "$SCRIPT" ] && echo yes || echo no)" "yes"
check "e11-density.sh executable" "$([ -x "$SCRIPT" ] && echo yes || echo no)" "yes"
if command -v shellcheck >/dev/null; then
  if shellcheck -S warning "$SCRIPT" >/tmp/e11-shellcheck.out 2>&1; then
    check "shellcheck -S warning" "clean" "clean"
  else
    check "shellcheck -S warning" "$(cat /tmp/e11-shellcheck.out)" "clean"
  fi
fi

# SC2154 (a variable referenced but never assigned) is an OPTIONAL shellcheck check, off by
# default at every severity -- so `shellcheck -S warning` passes a driver that references a
# variable nothing defines, and `bash -n` passes it too. Under these drivers' own
# `set -uo pipefail` that is a HARD RUNTIME FAILURE on the first line that reads it.
#
# This assertion exists because exactly that shipped: a fix to the grpcurl invocation
# introduced $PROTO_IMPORT_PATH and $PROTO_REL_PATH into BOTH drivers but defined them in
# only ONE, and nothing caught it -- not bash -n, not shellcheck at warning, not this suite,
# because the affected code path (rung 1 / the container arm) has never executed. It would
# have died on the metal box with "PROTO_IMPORT_PATH: unbound variable".
if command -v shellcheck >/dev/null; then
  if shellcheck -o check-unassigned-uppercase -S warning "$SCRIPT" >/tmp/e11-sc2154.out 2>&1; then
    check "no uppercase variable is referenced but never assigned (SC2154)" "clean" "clean"
  else
    check "no uppercase variable is referenced but never assigned (SC2154)" \
      "$(grep -c SC2154 /tmp/e11-sc2154.out) finding(s): $(grep SC2154 /tmp/e11-sc2154.out | head -3 | tr '\n' ' ')" "clean"
  fi
fi

echo "== it refuses to run without SH_SUBSTRATE / SH_SNAPSHOT_DIR / SH_WORKSPACE_ROOT / SH_MAX_COMMITTED_MB"
out=$(env -u SH_SUBSTRATE SH_SNAPSHOT_DIR=/tmp SH_WORKSPACE_ROOT=/tmp SH_MAX_COMMITTED_MB=1024 bash "$SCRIPT" 2>&1)
rc=$?
case "$out" in *SH_SUBSTRATE*) has_msg=yes ;; *) has_msg=no ;; esac
check "refuses without SH_SUBSTRATE (nonzero exit)" "$([ "$rc" -ne 0 ] && echo yes || echo no)" "yes"
check "refusal message names SH_SUBSTRATE" "$has_msg" "yes"

out=$(env -u SH_SNAPSHOT_DIR SH_SUBSTRATE=nested-m8i SH_WORKSPACE_ROOT=/tmp SH_MAX_COMMITTED_MB=1024 bash "$SCRIPT" 2>&1)
rc=$?
check "refuses without SH_SNAPSHOT_DIR" "$([ "$rc" -ne 0 ] && echo yes || echo no)" "yes"

out=$(env -u SH_WORKSPACE_ROOT SH_SUBSTRATE=nested-m8i SH_SNAPSHOT_DIR=/tmp SH_MAX_COMMITTED_MB=1024 bash "$SCRIPT" 2>&1)
rc=$?
check "refuses without SH_WORKSPACE_ROOT" "$([ "$rc" -ne 0 ] && echo yes || echo no)" "yes"

out=$(env -u SH_MAX_COMMITTED_MB SH_SUBSTRATE=nested-m8i SH_SNAPSHOT_DIR=/tmp SH_WORKSPACE_ROOT=/tmp bash "$SCRIPT" 2>&1)
rc=$?
case "$out" in *SH_MAX_COMMITTED_MB*) has_msg2=yes ;; *) has_msg2=no ;; esac
check "refuses without SH_MAX_COMMITTED_MB (nonzero exit)" "$([ "$rc" -ne 0 ] && echo yes || echo no)" "yes"
check "refusal message names SH_MAX_COMMITTED_MB" "$has_msg2" "yes"

# ---------------------------------------------------------------------------
# 1. "smaps_rollup is used and RSS is not"
# ---------------------------------------------------------------------------
echo "== smaps_rollup is used and RSS is not (with non-vacuousness proof)"

pss_body="$(extract_fn pss_bytes_for_pids || true)"
check "pss_bytes_for_pids helper exists" "$([ -n "$pss_body" ] && echo yes || echo no)" "yes"

if [ -n "$pss_body" ]; then
  pss_tmpdir="$(mktemp -d)"
  pss_snippet="$pss_tmpdir/pss.sh"
  {
    echo 'die() { echo "e11: $*" >&2; exit 1; }'
    printf '%s\n' "$pss_body"
  } >"$pss_snippet"

  # A real, still-alive process whose fake PROC_ROOT/<pid>/smaps_rollup we control directly.
  # One process, not an `sh -c` wrapper: see spawn_marker_process for why that distinction
  # cost a CI run. This block passes the pid EXPLICITLY, so it never depended on pgrep --
  # but killing the wrapper used to orphan its `sleep` child into later blocks that do.
  spawn_marker_process "$(marker_token pss_unit)"
  live_pid="$MARKER_PID"

  fake_proc="$pss_tmpdir/proc"
  mkdir -p "$fake_proc/$live_pid"

  # Case A (non-vacuousness proof): smaps_rollup MISSING for a live pid -> the
  # function DOES fail. This proves the failure path is reachable at all, before
  # we test that RSS is never used to route around it.
  rc_missing=0
  out_missing=$(
    PROC_ROOT="$fake_proc"
    export PROC_ROOT
    # shellcheck disable=SC1090
    . "$pss_snippet"
    pss_bytes_for_pids "$live_pid" 2>&1
  ) || rc_missing=$?
  case "$out_missing" in *smaps_rollup*) named_missing=yes ;; *) named_missing=no ;; esac
  check "non-vacuousness: unreadable smaps_rollup for a LIVE pid DOES fail (nonzero)" \
    "$([ "$rc_missing" -ne 0 ] && echo yes || echo no)" "yes"
  check "the failure names smaps_rollup, not a generic error" "$named_missing" "yes"

  # Case B: smaps_rollup present -> sums the Pss: lines, ignoring any Rss: lines
  # placed in the same file (proves it is reading Pss specifically, not just
  # whatever numeric field appears first).
  {
    echo "Rss:              999999 kB"
    echo "Pss:                 512 kB"
    echo "Pss_Anon:             256 kB"
  } >"$fake_proc/$live_pid/smaps_rollup"
  out_present=$(
    PROC_ROOT="$fake_proc"
    export PROC_ROOT
    # shellcheck disable=SC1090
    . "$pss_snippet"
    pss_bytes_for_pids "$live_pid"
  )
  check "reads Pss (512 kB -> 524288 bytes), ignoring the Rss line in the same file" \
    "$out_present" "524288"

  # Case C: pid already exited between discovery and sampling (no smaps_rollup,
  # kill -0 fails) -> contributes 0, is NOT treated as an unreadable-file failure.
  dead_pid=99999
  while kill -0 "$dead_pid" 2>/dev/null; do dead_pid=$((dead_pid + 1)); done
  rc_dead=0
  out_dead=$(
    PROC_ROOT="$fake_proc"
    export PROC_ROOT
    # shellcheck disable=SC1090
    . "$pss_snippet"
    pss_bytes_for_pids "$dead_pid"
  ) || rc_dead=$?
  check "an already-exited pid contributes 0, is not an unreadable-file failure" "$rc_dead" "0"
  check "an already-exited pid's contribution is exactly 0 bytes" "$out_dead" "0"

  stop_marker_process "$live_pid"
  rm -rf "$pss_tmpdir"
fi

# ---------------------------------------------------------------------------
# 1b. The PSS helper's ONLY integration point: the JSON assembly that consumes it.
#
# Final-review H2. mem_available_bytes' awk was
#   /^MemAvailable:/{print $2*1024; exit} END{if (!found) print 0}
# with `found` never assigned; awk's `exit` in a main rule RUNS the END block, so on any
# Linux host this printed TWO lines. Interpolated into host_signals_snapshot's printf it
# put a newline inside a JSON numeric value, all four json.load calls in the rung-record
# writer failed, the writer died on a SyntaxError from the resulting empty interpolations,
# and because this driver runs `set -uo pipefail` WITHOUT `set -e` nothing aborted: E11
# completed its whole sweep having written zero rung records, and exited 0.
#
# It never showed up here because darwin has no /proc/meminfo, so the `|| echo 0` fallback
# yielded a clean single "0". Every case below therefore drives a LINUX-SHAPED fixture
# through the SH_E11_PROC_ROOT seam that already existed for the PSS helper -- it only ever
# needed a meminfo in it.
# ---------------------------------------------------------------------------
echo "== host signal assembly against a Linux-shaped /proc (final review H2)"

signals_body="$(extract_fns die require_numeric proc_meminfo_available mem_available_bytes discover_pids pss_bytes_for_pids host_cpu_fraction host_signals_snapshot || true)"
check "die/require_numeric/mem_available_bytes/host_signals_snapshot all extractable" \
  "$([ -n "$signals_body" ] && echo yes || echo no)" "yes"

if [ -n "$signals_body" ]; then
  sig_tmpdir="$(mktemp -d)"
  sig_snippet="$sig_tmpdir/signals.sh"
  printf '%s\n' "$signals_body" >"$sig_snippet"

  # A Linux-shaped /proc: meminfo with a real MemAvailable line, a /proc/stat cpu line,
  # and a smaps_rollup for one live pid.
  sig_proc="$sig_tmpdir/proc"
  mkdir -p "$sig_proc"
  printf 'MemTotal:       16384000 kB\nMemFree:            1000 kB\nMemAvailable:    8192000 kB\n' >"$sig_proc/meminfo"
  printf 'cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 100 0 100 800 0 0 0 0 0 0\n' >"$sig_proc/stat"

  # --- NON-VACUOUSNESS, first: prove the pathology is REAL and REACHABLE against this
  # exact fixture, before asserting it is absent. The pre-fix awk form is run here
  # verbatim; if it did not emit two lines against this meminfo, every assertion below
  # would be passing for the wrong reason.
  buggy_lines="$(awk '/^MemAvailable:/{print $2*1024; exit} END{if (!found) print 0}' "$sig_proc/meminfo" | wc -l | tr -d ' ')"
  check "non-vacuousness: the PRE-FIX awk form really does emit 2 lines on this fixture" \
    "$buggy_lines" "2"
  # ...and that a two-line value really does break the consumer, not merely look odd.
  buggy_json="$(printf '{"memAvailableBytes":%s}' "$(awk '/^MemAvailable:/{print $2*1024; exit} END{if (!found) print 0}' "$sig_proc/meminfo")")"
  buggy_rc=0
  printf '%s' "$buggy_json" | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null || buggy_rc=$?
  check "non-vacuousness: a two-line value really does make json.load fail" \
    "$([ "$buggy_rc" -ne 0 ] && echo yes || echo no)" "yes"

  # --- The fix: exactly one line, and the right number (8192000 kB * 1024).
  mem_out=$(
    PROC_ROOT="$sig_proc"
    export PROC_ROOT
    # shellcheck disable=SC1090
    . "$sig_snippet"
    mem_available_bytes
  )
  check "mem_available_bytes emits exactly ONE line on a Linux-shaped meminfo" \
    "$(printf '%s\n' "$mem_out" | wc -l | tr -d ' ')" "1"
  check "mem_available_bytes converts kB to bytes correctly" "$mem_out" "8388608000"

  # --- REGRESSION, found by the first-ever execution on a Linux host with real memory.
  # The old awk form was `print $2*1024`, and awk's OFMT defaults to "%.6g", so any product
  # needing more than 6 significant digits printed in SCIENTIFIC NOTATION. require_numeric
  # refuses that, so host_signals_snapshot failed and EVERY RUNG WAS REFUSED. This fixture's
  # 8192000 kB is small enough to print as an integer, which is exactly why the suite stayed
  # green while the driver could not record a single rung on any host with >~16 GiB available.
  printf 'MemAvailable:    790000000 kB\n' >"$sig_proc/meminfo-huge"
  # NON-VACUOUSNESS, and it is PLATFORM-DEPENDENT -- which is the other half of why this
  # defect survived every review. awk's OFMT default of "%.6g" is what produces the scientific
  # form, but implementations differ on whether an integral double is subject to it: Debian's
  # mawk prints 8.0896e+11, while macOS's awk and gawk print 808960000000. CI runs ubuntu, so
  # the proof below does fire there; on a dev macOS it cannot, and a check that FAILED there
  # would be a false alarm about correct code. So the pathology is proven where it exists and
  # explicitly skipped where it does not -- the FIX's own behaviour is asserted either way.
  huge_awk="$(awk '/^MemAvailable:/{print $2*1024; exit}' "$sig_proc/meminfo-huge")"
  case "$huge_awk" in
  *e+* | *E+*)
    check "non-vacuousness: this awk DOES emit scientific notation on a 754GiB-class host" \
      "yes" "yes"
    huge_rc=0
    (
      # shellcheck disable=SC1090
      . "$sig_snippet"
      require_numeric memAvailableBytes "$huge_awk"
    ) >/dev/null 2>&1 || huge_rc=$?
    check "  ...and require_numeric refuses it (this is what refused every rung on metal)" \
      "$([ "$huge_rc" -ne 0 ] && echo yes || echo no)" "yes"
    ;;
  *)
    echo "  (skip: this awk prints '$huge_awk' rather than scientific notation, so the pre-fix"
    echo "   pathology is not reproducible on this platform -- it IS on Debian/mawk, which is"
    echo "   where the first real execution hit it. The fix is still asserted below.)"
    ;;
  esac
  # THE FIX: a bare 64-bit integer, whatever awk the host ships.
  huge_out=$(
    PROC_ROOT="$sig_proc"
    export PROC_ROOT
    # shellcheck disable=SC1090
    . "$sig_snippet"
    cp "$sig_proc/meminfo-huge" "$sig_proc/meminfo"
    mem_available_bytes
  )
  check "mem_available_bytes emits a bare integer on a 754GiB-class host" "$huge_out" "808960000000"
  check "  ...on exactly one line" "$(printf '%s\n' "$huge_out" | wc -l | tr -d ' ')" "1"
  huge_ok_rc=0
  (
    # shellcheck disable=SC1090
    . "$sig_snippet"
    require_numeric memAvailableBytes "808960000000"
  ) >/dev/null 2>&1 || huge_ok_rc=$?
  check "  ...which require_numeric accepts, so the rung can be recorded" "$huge_ok_rc" "0"
  printf 'MemTotal:       16384000 kB\nMemFree:            1000 kB\nMemAvailable:    8192000 kB\n' >"$sig_proc/meminfo"
  check "mem_available_bytes no longer forks an awk (it uses the sampler's builtin reader)" \
    "$(printf '%s\n' "$(extract_fn mem_available_bytes)" | grep -cE '\bawk\b')" "0"

  # A meminfo with no MemAvailable line at all: the END fallback, still one line.
  printf 'MemTotal:       16384000 kB\n' >"$sig_proc/meminfo-noavail"
  mem_none=$(
    PROC_ROOT="$sig_proc"
    export PROC_ROOT
    # shellcheck disable=SC1090
    . "$sig_snippet"
    awk '/^MemAvailable:/{found=1; print $2*1024; exit} END{if (!found) print 0}' "$sig_proc/meminfo-noavail"
  )
  check "no MemAvailable line -> a single 0 (the END fallback still fires)" "$mem_none" "0"
  printf 'MemTotal:       16384000 kB\nMemFree:            1000 kB\nMemAvailable:    8192000 kB\n' >"$sig_proc/meminfo"

  # --- require_numeric: the guard that keeps this class from recurring. Refuses a
  # multi-line value even though EVERY line of it is numeric, which is precisely the
  # shape H2 had.
  rn_rc=0
  rn_out=$(
    # shellcheck disable=SC1090
    . "$sig_snippet"
    require_numeric memAvailableBytes "$(printf '8388608000\n0')" 2>&1
  ) || rn_rc=$?
  check "require_numeric REFUSES a two-line all-numeric value (nonzero)" \
    "$([ "$rn_rc" -ne 0 ] && echo yes || echo no)" "yes"
  case "$rn_out" in *memAvailableBytes*) rn_named=yes ;; *) rn_named=no ;; esac
  check "the refusal names the offending FIELD, not just 'bad input'" "$rn_named" "yes"
  rn_ok_rc=0
  rn_ok=$(
    # shellcheck disable=SC1090
    . "$sig_snippet"
    require_numeric memAvailableBytes "8388608000"
  ) || rn_ok_rc=$?
  check "require_numeric accepts a single integer (does not refuse everything)" "$rn_ok" "8388608000"
  check "  ...with exit 0" "$rn_ok_rc" "0"
  rn_frac=$(
    # shellcheck disable=SC1090
    . "$sig_snippet"
    require_numeric hostCpuFraction "0.5000"
  )
  check "require_numeric accepts a decimal (hostCpuFraction is printf %.4f)" "$rn_frac" "0.5000"

  # --- The whole assembly, end to end, parsed by its REAL consumer (json.load), with a
  # live pid whose smaps_rollup exists so no other field can fail for its own reasons.
  sig_marker="$(marker_token signals)"
  spawn_marker_process "$sig_marker"
  sig_live="$MARKER_PID"
  mkdir -p "$sig_proc/$sig_live"
  printf 'Pss:                 512 kB\n' >"$sig_proc/$sig_live/smaps_rollup"
  sig_json=$(
    PROC_ROOT="$sig_proc"
    export PROC_ROOT
    VMM_PROC_PATTERN="__e11_no_such_process__"
    VIRTIOFSD_PROC_PATTERN="__e11_no_such_process__"
    # shellcheck disable=SC1090
    . "$sig_snippet"
    host_signals_snapshot
  )
  sig_json_rc=0
  sig_mem="$(printf '%s' "$sig_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["memAvailableBytes"])' 2>&1)" || sig_json_rc=$?
  check "host_signals_snapshot's output parses as JSON (all four json.load calls' premise)" \
    "$sig_json_rc" "0"
  check "  ...and memAvailableBytes survives the round trip intact" "$sig_mem" "8388608000"

  # --- And the failure direction: a bad field makes the WHOLE snapshot fail loudly and
  # print nothing, rather than emit a malformed object for a consumer to choke on 350
  # lines later. Provoked with an unreadable smaps_rollup for a LIVE pid, the one
  # refusal spec section 7.3's boxed warning makes non-negotiable -- which previously
  # could not stop anything, because a `die` inside `x="$(helper)"` exits only the
  # command substitution's subshell and `set -e` is not in force.
  chmod 000 "$sig_proc/$sig_live/smaps_rollup" 2>/dev/null || true
  sig_fail_rc=0
  sig_fail_out=$(
    PROC_ROOT="$sig_proc"
    export PROC_ROOT
    # shellcheck disable=SC2034 # read by host_signals_snapshot, sourced below
    # The marker token, not "sleep 5": under dash that pattern also matched a forked child
    # this fixture never covered, so the refusal below could fire for the WRONG reason (an
    # uncovered sibling) rather than the chmod 000 rollup this case is about.
    VMM_PROC_PATTERN="$sig_marker"
    # shellcheck disable=SC2034
    VIRTIOFSD_PROC_PATTERN="__e11_no_such_process__"
    # shellcheck disable=SC1090
    . "$sig_snippet"
    host_signals_snapshot
  ) || sig_fail_rc=$?
  if [ -r "$sig_proc/$sig_live/smaps_rollup" ]; then
    echo "  (skip: running as root or on a filesystem ignoring chmod 000 -- the unreadable-rollup case was not exercised, not claimed verified)"
  else
    check "an unsampleable signal makes host_signals_snapshot exit NONZERO" \
      "$([ "$sig_fail_rc" -ne 0 ] && echo yes || echo no)" "yes"
    check "  ...and print no JSON at all, rather than a malformed object" "$sig_fail_out" ""
  fi
  chmod 644 "$sig_proc/$sig_live/smaps_rollup" 2>/dev/null || true

  stop_marker_process "$sig_live"
  rm -rf "$sig_tmpdir"
fi

echo "== a rung that writes no record fails loudly (final review H2)"
# The driver runs `set -uo pipefail` without `set -e`, deliberately (see the assertion's
# own comment in the script). That makes an explicit check for the record the only thing
# standing between a failed writer and a sweep that exits 0 having recorded nothing.
# The DRIVER's own shell options are the first `set` line in the file. Matched that way
# rather than by grepping the whole script for `set -e`, because build_converge_script's
# heredoc legitimately contains `set -eu` for the GUEST script it emits -- a whole-file
# grep would conflate the two and go red on correct code.
check "the driver's own shell options are exactly 'set -uo pipefail'" \
  "$(grep -m1 -E '^set ' "$SCRIPT")" "set -uo pipefail"
check "run_density_rung dies when out_json_path is empty or missing" \
  "$([ "$(grep -c 'wrote no record to' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "the record assertion tests the file, not the writer's exit status" \
  "$([ "$(grep -c '\[ -s "\$out_json_path" \]' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"

# ---------------------------------------------------------------------------
# The record writer, ACTUALLY RUN with container-arm inputs (review 4001908573).
#
# `run_density_rung container - - "$c"` passed a literal "-" for standbyDepth and
# guestRamMb, and the writer interpolated them as bare Python numeric literals
# (`'standbyDepth': -,`). Every container rung raised a SyntaxError, wrote no record, and
# tripped the `[ -s ]` guard; because shuffle_e11_arms randomises arm order, about half of
# all runs died there before the microvm arm ran at all. The arm the whole experiment is
# priced against recorded nothing.
#
# The old assertion for this call site was `grep -c 'run_density_rung container'` -- it
# asserted the call's PRESENCE and never executed a line of the generated Python, so no
# test could catch it. This section extracts the writer's own source text out of the real
# script and RUNS it, once with the pre-fix interpolation (proving the SyntaxError is real)
# and once as the script now generates it.
# ---------------------------------------------------------------------------
echo "== the rung-record writer, executed with real container-arm inputs"

# extract_record_writer prints the exact `python3 -c "..."` command run_density_rung uses,
# from its opening line through the closing bare `"`.
extract_record_writer() {
  awk '
    !f && $0 == "  python3 -c \"" { f = 1; print; next }
    f { print; if ($0 == "\"") exit }
  ' "$SCRIPT"
}

writer_body="$(extract_record_writer)"
check "the record writer is extractable from the real script" \
  "$([ -n "$writer_body" ] && echo yes || echo no)" "yes"
check "  ...and it is the writer (it opens the out path for writing)" \
  "$(printf '%s\n' "$writer_body" | grep -c "open('\$out_json_path', 'w')")" "1"

dim_body="$(extract_fns die require_numeric dimension_literal static_settings_json || true)"
check "dimension_literal is extractable" "$([ -n "$dim_body" ] && echo yes || echo no)" "yes"

if [ -n "$writer_body" ] && [ -n "$dim_body" ]; then
  wr_tmpdir="$(mktemp -d)"
  # run_writer evaluates the REAL extracted writer with one full set of rung values.
  # $1 is the value for standbyDepth/guestRamMb's interpolation, so the caller chooses
  # between the pre-fix bare "-" and what dimension_literal now produces.
  # Every assignment below is read by the EXTRACTED writer source, which shellcheck cannot
  # see through the eval -- that is the whole point of driving the real generated code.
  # shellcheck disable=SC2034,SC2317
  run_writer() {
    (
      # shellcheck disable=SC1090
      . "$wr_tmpdir/dims.sh"
      d_json="$1" ram_json="$1"
      out_json_path="$2"
      arm=container d=- ram_mb=-
      c=1 throughput=0.5000 p95=12 cold_rate=0.0000
      # The in-rung sampled signals (#291 item 1). cpu_mean is what crosses('cpu') reads.
      cpu_mean=0.4100 cpu_peak=0.9700 cpu_min=0.0500 cpu_samples=12 cores_busy=29.5200
      mem_mean=8388608000 mem_min=8000000000
      pss_mean=524288 pss_peak=1048576 pss_samples=3 pss_refused_ticks=0
      proc_mean=0 proc_peak=2 proc_samples=3
      # The retained post-load snapshot, under its own names.
      post_cpu=0.0006 post_mem=8388608000 post_pss=0 post_proc=0
      SAMPLE_LOW_EVERY=5
      standbys_resident=0 idle_residency=0 reclaim_converge_s=0 converge_p50=7
      errors_json='{}'
      SUBSTRATE=nested-m8i REPO_CACHE_SHAPE=accept-cold-fetch COLD_LATENCY_MS=50
      E11_RUN_ID=RUN-FIXTURE
      # #294's interpolations. The label is what the checks below assert; the two notes stand
      # in for the long disclosure strings, whose presence (not text) is what matters here.
      exec_client_json=grpcurl-per-exec
      driver_control_note='driver-control is a STRICT LOWER BOUND on driver-only cost'
      exec_error_note='an in-stream ExecEvent.error is recorded as status=ok'
      eval "$writer_body"
    )
  }
  printf '%s\n' "$dim_body" >"$wr_tmpdir/dims.sh"

  # --- NON-VACUOUSNESS: the pre-fix literal really does kill the writer, against this
  # exact record shape. Without this, the success below could be passing for any reason.
  pre_out="$wr_tmpdir/prefix.json"
  pre_rc=0
  pre_err="$(run_writer '-' "$pre_out" 2>&1)" || pre_rc=$?
  check "non-vacuousness: the pre-fix bare '-' literal DOES break the writer (nonzero)" \
    "$([ "$pre_rc" -ne 0 ] && echo yes || echo no)" "yes"
  case "$pre_err" in *SyntaxError*) pre_syn=yes ;; *) pre_syn=no ;; esac
  check "  ...with a SyntaxError, exactly as the review describes" "$pre_syn" "yes"
  check "  ...and it writes NO record at all (which is what the [ -s ] guard then catches)" \
    "$([ -s "$pre_out" ] && echo wrote || echo nothing)" "nothing"

  # --- The fix: dimension_literal maps the container arm's "-" to None, and the writer
  # produces a record that json.load accepts with standbyDepth/guestRamMb null.
  ok_out="$wr_tmpdir/container.json"
  ok_rc=0
  ok_err="$(
    # shellcheck disable=SC1090
    . "$wr_tmpdir/dims.sh"
    run_writer "$(dimension_literal standbyDepth - 0)" "$ok_out" 2>&1
  )" || ok_rc=$?
  check "the container arm's record writes successfully (exit 0)" "$ok_rc" "0"
  check "  ...with no error output" "$ok_err" ""
  check "  ...and the record is non-empty, so the [ -s ] guard passes" \
    "$([ -s "$ok_out" ] && echo yes || echo no)" "yes"
  parsed_rc=0
  parsed="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["standbyDepth"], d["guestRamMb"], d["c"], d["p95Ms"])' "$ok_out" 2>&1)" || parsed_rc=$?
  check "  ...and json.load parses it (the real consumer of every rung record)" "$parsed_rc" "0"
  check "  ...with the not-applicable dimensions as JSON null, not 0" "$parsed" "None None 1 12"

  new_fields_rc=0
  new_fields="$(python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
want = ["hostCpuFraction","hostCpuFractionPeak","hostCpuFractionMin","hostCpuSamples",
        "coresBusy","memAvailableBytes","memAvailableBytesMin","pssBytes","pssBytesPeak",
        "pssSamples","processCount","processCountPeak","processCountSamples","samplingMode",
        "postLoadHostCpuFraction","postLoadMemAvailableBytes","postLoadPssBytes",
        "postLoadProcessCount"]
missing = [k for k in want if k not in d]
print("missing:" + ",".join(missing) if missing else "all-present")
' "$ok_out" 2>&1)" || new_fields_rc=$?
  check "the record carries every field the #291 schema adds" "$new_fields" "all-present"
  check "  ...and json.load accepted it" "$new_fields_rc" "0"
  check "hostCpuFraction in the record is the UNDER-LOAD mean, not the post-load 0.0006" \
    "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["hostCpuFraction"])' "$ok_out")" "0.41"
  check "  ...and the idle reading is still there, under its own name" \
    "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["postLoadHostCpuFraction"])' "$ok_out")" "0.0006"
  check "coresBusy is recorded, because 29.52 cores is legible where 0.41 is not" \
    "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["coresBusy"])' "$ok_out")" "29.52"
  check "samplingMode marks how these numbers were taken" \
    "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["samplingMode"])' "$ok_out")" "in-rung-1hz-mean"
  check "the PSS/processCount cadence is disclosed in the record's own proxyLimitations" \
    "$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("yes" if any("sampler tick" in v for v in d["proxyLimitations"].values()) else "no")' "$ok_out")" "yes"
  # Provenance: which client issued the Execs this record's latencies came from (#294). Without
  # it a go-driven ladder and a grpcurl-driven one are indistinguishable JSON, and comparing
  # them is the whole point of building the second client.
  check "the record carries execClient" \
    "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["execClient"])' "$ok_out")" "grpcurl-per-exec"
  check "  ...and drivingModel is unchanged (open-loop is out of scope for #294)" \
    "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["drivingModel"])' "$ok_out")" "closed-loop-per-slot"
  # The ExecError disclosure belongs in EVERY record, not only the Go ones: on the grpcurl path
  # it is a live defect an operator reading these numbers needs to know about.
  check "proxyLimitations discloses the ExecError status behaviour" \
    "$(python3 -c 'import json,sys; print("execErrorStatus" in json.load(open(sys.argv[1]))["proxyLimitations"])' "$ok_out")" "True"

  # --- And the microvm arm's numbers stay NUMBERS (null there would be the sweep losing
  # the dimension it is sweeping, so dimension_literal refuses it).
  mv_out="$wr_tmpdir/microvm.json"
  mv_rc=0
  (
    # shellcheck disable=SC1090
    . "$wr_tmpdir/dims.sh"
    run_writer "$(dimension_literal standbyDepth 2 1)" "$mv_out"
  ) || mv_rc=$?
  check "the microvm arm's record writes successfully" "$mv_rc" "0"
  check "  ...with standbyDepth recorded as the NUMBER it swept, not a string" \
    "$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(repr(d["standbyDepth"]))' "$mv_out" 2>&1)" "2"

  # --- dimension_literal's own contract, driven directly.
  dl() {
    (
      # shellcheck disable=SC1090
      . "$wr_tmpdir/dims.sh"
      dimension_literal "$@"
    )
  }
  check "dimension_literal('-', not required) -> Python None (JSON null)" "$(dl standbyDepth - 0)" "None"
  check "dimension_literal('', not required) -> Python None too" "$(dl standbyDepth '' 0)" "None"
  check "dimension_literal(2, required) -> 2" "$(dl standbyDepth 2 1)" "2"
  dl_req_rc=0
  dl_req_out="$(dl standbyDepth - 1 2>&1)" || dl_req_rc=$?
  check "dimension_literal('-', REQUIRED) refuses: the microvm arm cannot lose its D" \
    "$([ "$dl_req_rc" -ne 0 ] && echo yes || echo no)" "yes"
  case "$dl_req_out" in *standbyDepth*) dl_named=yes ;; *) dl_named=no ;; esac
  check "  ...and the refusal names the field" "$dl_named" "yes"
  dl_bad_rc=0
  dl_bad_out="$(
    (
      # shellcheck disable=SC1090
      . "$wr_tmpdir/dims.sh"
      dimension_literal standbyDepth 'rm -rf /' 0
    ) 2>&1
  )" || dl_bad_rc=$?
  check "dimension_literal refuses a non-numeric value outright (no injection into Python)" \
    "$([ "$dl_bad_rc" -ne 0 ] && echo yes || echo no)" "yes"
  check "  ...and prints nothing that could reach the writer" \
    "$(printf '%s' "$dl_bad_out" | grep -c 'rm -rf /$')" "0"

  rm -rf "$wr_tmpdir"
fi

echo "== execClient labels both clients, and nothing else (#294)"
ecl_body="$(extract_fn exec_client_label || true)"
check "exec_client_label is extractable" "$([ -n "$ecl_body" ] && echo yes || echo no)" "yes"
for pair in "grpcurl:grpcurl-per-exec" "go:go-persistent-conn"; do
  client="${pair%%:*}"
  want="${pair##*:}"
  got="$(
    EXEC_CLIENT="$client"
    eval "$ecl_body"
    exec_client_label
  )"
  check "exec_client_label maps '$client' to '$want'" "$got" "$want"
done

echo "== the two path-dependent disclosures are chosen by client, and differ (#294)"
dn_body="$(extract_fns driver_control_note_for exec_error_note_for || true)"
check "the disclosure functions are extractable" "$([ -n "$dn_body" ] && echo yes || echo no)" "yes"

dcn_go="$(eval "$dn_body"; driver_control_note_for go)"
dcn_gc="$(eval "$dn_body"; driver_control_note_for grpcurl)"
een_go="$(eval "$dn_body"; exec_error_note_for go)"
een_gc="$(eval "$dn_body"; exec_error_note_for grpcurl)"

# Path-specific CONTENT, not just "non-empty". A swap between the branches is the failure this
# catches: the go path must not claim an ExecError is recorded as ok, and the grpcurl path must not
# claim it is recorded as err.
check "the go exec-error disclosure says status=err" \
  "$(printf '%s' "$een_go" | grep -Fc 'recorded as status=err')" "1"
check "  ...and does NOT claim status=ok for itself" \
  "$(printf '%s' "$een_go" | grep -Fc 'is recorded as status=ok')" "0"
check "the grpcurl exec-error disclosure says status=ok" \
  "$(printf '%s' "$een_gc" | grep -Fc 'recorded as status=ok')" "1"
check "the go driver-control disclosure marks the bound's tightness as unmeasured" \
  "$(printf '%s' "$dcn_go" | grep -Fc 'its net effect on tightness is UNMEASURED')" "1"
check "the grpcurl driver-control disclosure keeps the STRICT LOWER BOUND wording" \
  "$(printf '%s' "$dcn_gc" | grep -Fc 'STRICT LOWER BOUND')" "1"
# The two paths must actually differ -- if both branches returned the same string, every check above
# could still pass while the disclosure stopped distinguishing the clients at all.
check "the two exec-error disclosures differ between clients" \
  "$([ "$een_go" != "$een_gc" ] && echo differ || echo same)" "differ"
check "the two driver-control disclosures differ between clients" \
  "$([ "$dcn_go" != "$dcn_gc" ] && echo differ || echo same)" "differ"
# An unknown client must fall to the grpcurl text, matching exec_client_label's own defaulting, so a
# future third client cannot silently acquire the go disclosures.
check "an unrecognised client gets the grpcurl disclosures" \
  "$([ "$(eval "$dn_body"; exec_error_note_for xyzzy)" = "$een_gc" ] && echo yes || echo no)" "yes"
# Unsafe-character safety: these disclosure strings are interpolated into the record writer's
# python3 -c "..." body through a DOUBLE-quoted bash string (deploy/microvm/e11-density.sh), so
# an apostrophe, a $, a backtick or a backslash in the disclosure text would be expanded or
# reinterpreted by bash and/or python before the record writer ever ran -- reject all four.
check "no disclosure contains an apostrophe, a dollar sign, a backtick, or a backslash" \
  "$(printf '%s%s%s%s' "$dcn_go" "$dcn_gc" "$een_go" "$een_gc" | tr -cd "'\$\`\\\\" | wc -c | tr -d ' ')" "0"

# ---------------------------------------------------------------------------
# percentile: a missing/empty input is a refusal, not a zero (review 4001908597).
# ---------------------------------------------------------------------------
echo "== percentile refuses an absent measurement instead of printing 0"

pct_body="$(extract_fn percentile || true)"
check "percentile is extractable" "$([ -n "$pct_body" ] && echo yes || echo no)" "yes"

if [ -n "$pct_body" ]; then
  pct_tmpdir="$(mktemp -d)"
  pct_snippet="$pct_tmpdir/pct.sh"
  printf '%s\n' "$pct_body" >"$pct_snippet"
  missing="$pct_tmpdir/never-created"

  # --- NON-VACUOUSNESS, first: the PRE-FIX pipeline really did produce a TWO-LINE value
  # for a missing file under `pipefail` + `|| echo 0`. This is the H2 shape reappearing:
  # `sort` exits 2, awk still prints 0, pipefail propagates sort's status, and `|| echo 0`
  # appends a second line. Run verbatim here so the assertions below cannot pass vacuously.
  prefix_value="$(
    set -uo pipefail
    prefix_percentile() {
      sort -n "$1" | awk 'END { if (NR == 0) { print 0; exit } }'
    }
    prefix_percentile "$missing" 2>/dev/null || echo 0
  )"
  check "non-vacuousness: the pre-fix form really does yield TWO lines on a missing file" \
    "$(printf '%s\n' "$prefix_value" | wc -l | tr -d ' ')" "2"
  # ...and that a two-line value really is fatal to the record writer's interpolation.
  prefix_rc=0
  python3 -c "
rec = {'p95Ms': $prefix_value}
print(rec)
" >/dev/null 2>&1 || prefix_rc=$?
  check "non-vacuousness: a two-line p95 really does make the writer's Python fail" \
    "$([ "$prefix_rc" -ne 0 ] && echo yes || echo no)" "yes"

  # --- The fix: a missing file is a refusal that prints NOTHING.
  pct_missing_rc=0
  pct_missing_out="$(
    # shellcheck disable=SC1090
    . "$pct_snippet"
    percentile 95 "$missing" 2>/dev/null
  )" || pct_missing_rc=$?
  check "percentile on a missing file exits nonzero" \
    "$([ "$pct_missing_rc" -ne 0 ] && echo yes || echo no)" "yes"
  check "  ...and prints nothing at all (not a 0 that reads as a fast rung)" "$pct_missing_out" ""

  : >"$pct_tmpdir/empty"
  pct_empty_rc=0
  pct_empty_out="$(
    # shellcheck disable=SC1090
    . "$pct_snippet"
    percentile 95 "$pct_tmpdir/empty" 2>/dev/null
  )" || pct_empty_rc=$?
  check "percentile on an EMPTY file also refuses" \
    "$([ "$pct_empty_rc" -ne 0 ] && echo yes || echo no)" "yes"
  check "  ...printing nothing" "$pct_empty_out" ""

  # --- And it still computes the right nearest-rank percentile on real data, so the
  # refusals above are not just "percentile stopped working".
  printf '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n' >"$pct_tmpdir/ten"
  pct_ok="$(
    # shellcheck disable=SC1090
    . "$pct_snippet"
    percentile 95 "$pct_tmpdir/ten"
  )"
  check "percentile 95 over 1..10 is still the nearest-rank 9" "$pct_ok" "9"
  pct_ok50="$(
    # shellcheck disable=SC1090
    . "$pct_snippet"
    percentile 50 "$pct_tmpdir/ten"
  )"
  check "percentile 50 over 1..10 is still 5" "$pct_ok50" "5"
  pct_one="$(
    # shellcheck disable=SC1090
    . "$pct_snippet"
    printf '42\n' >"$pct_tmpdir/one"
    percentile 95 "$pct_tmpdir/one"
  )"
  check "a single sample is a legitimate distribution (not refused)" "$pct_one" "42"

  rm -rf "$pct_tmpdir"
fi

echo "== no value-producing helper is left with the '|| echo' two-line shape"
# The whole class, audited rather than the one instance (review 4001908597). Every
# `|| echo` in this file must sit on a SINGLE command, never on a pipeline: with
# `pipefail`, a failing pipeline that still printed something turns `|| echo X` into a
# two-line value. Comments are stripped so the explanations of the defect do not count.
pipeline_or_echo="$(grep -v '^[[:space:]]*#' "$SCRIPT" | grep -nE '\|[^|]+\|\| *echo' || true)"
check "no '<pipeline> || echo' remains anywhere in the driver" \
  "$([ -z "$pipeline_or_echo" ] && echo yes || echo no)" "yes"
# The one remaining `|| echo 0` is mem_available_bytes' single awk (not a pipeline), and it
# is validated by require_numeric on the way into the record.
check "percentile's call sites no longer swallow its status with '|| echo 0'" \
  "$(grep -c 'percentile .* || echo' "$SCRIPT")" "0"
check "the five derived rung fields now go through require_numeric" \
  "$(grep -cE 'require_numeric (p95Ms|throughput|coldAcquireRate|convergeMsP50|wallSeconds)' "$SCRIPT")" "5"

# ---------------------------------------------------------------------------
# Issue #291 item 2: payload construction leaves the timed window.
#
# grpc_exec_record used to run mktemp, date, json_escape x2 (python3 x2), grpcurl, date,
# rm, plus wc -l x2 in the caller's loop guard -- ~9 process creations per Exec, two of
# them interpreter startups, and t0 was stamped BEFORE the compound whose argument list
# contained both command substitutions, so both interpreter startups fell inside the
# measured latency. At c=64 that is ~64 slots x ~9 spawns continuously, which is enough to
# produce the observed c=8 knee with no contribution from the backend at all.
#
# Two properties are asserted: the payload is byte-identical to what json_escape produced
# (the correctness risk in moving escaping out of the loop), and the timed window contains
# none of the removed spawns (the regression that would silently undo the fix).
# ---------------------------------------------------------------------------
echo "== per-Exec payload construction is pre-escaped, outside the timed window (#291 item 2)"

esc_body="$(extract_fns json_escape e11_tool_call_mix escaped_mix || true)"
check "escaped_mix is extractable alongside json_escape and the mix" \
  "$([ -n "$esc_body" ] && echo yes || echo no)" "yes"

if [ -n "$esc_body" ]; then
  esc_tmpdir="$(mktemp -d)"
  esc_snippet="$esc_tmpdir/esc.sh"
  printf '%s\n' "$esc_body" >"$esc_snippet"

  # The hazardous command: a double quote AND a backslash, the two characters that make
  # naive bash interpolation produce JSON that either fails to parse or silently changes
  # the command the sandbox runs.
  hazard='echo "a\b" > /tmp/x'

  esc_pair=$(
    # shellcheck disable=SC1090
    . "$esc_snippet"
    # Override the mix with the single hazardous command, so escaped_mix's own output can be
    # compared against json_escape of the same string.
    e11_tool_call_mix() { printf '%s\n' 'echo "a\b" > /tmp/x'; }
    printf '%s\n%s\n' "$(escaped_mix)" "$(json_escape 'echo "a\b" > /tmp/x')"
  )
  esc_new="$(printf '%s\n' "$esc_pair" | sed -n 1p)"
  esc_old="$(printf '%s\n' "$esc_pair" | sed -n 2p)"
  check "escaped_mix is byte-identical to json_escape on a command with a quote and a backslash" \
    "$esc_new" "$esc_old"

  # And the assembled payload -- the thing grpcurl actually receives -- round-trips through
  # the real consumer with the command unchanged.
  esc_payload="{\"sandbox_id\":\"e11-test\",\"exec\":{\"req_id\":7,\"command\":$esc_new,\"timeout_s\":30,\"workspace_key\":\"ws-1\"}}"
  esc_rt_rc=0
  esc_rt="$(printf '%s' "$esc_payload" | python3 -c 'import json,sys; print(json.load(sys.stdin)["exec"]["command"])' 2>&1)" || esc_rt_rc=$?
  check "the assembled payload parses as JSON" "$esc_rt_rc" "0"
  check "  ...with the command byte-for-byte what was asked for" "$esc_rt" "$hazard"

  # Ordering and count: the mix has 7 commands and escaped_mix must preserve both.
  esc_count=$(
    # shellcheck disable=SC1090
    . "$esc_snippet"
    escaped_mix | wc -l | tr -d ' '
  )
  check "escaped_mix emits one line per mix command (7)" "$esc_count" "7"
  esc_first=$(
    # shellcheck disable=SC1090
    . "$esc_snippet"
    escaped_mix | sed -n 1p
  )
  check "  ...in the mix's own order (first is 'true')" "$esc_first" '"true"'

  rm -rf "$esc_tmpdir"
fi

echo "== the timed window forks nothing but grpcurl (#291 item 2, the regression guard)"
# timed_window_body prints exactly what runs inside the measured window: run_density_rung's
# lines strictly BETWEEN the wall_t0 and wall_t1 stamps (excluding both stamp lines
# themselves -- neither stamp's own assignment runs DURING the interval it delimits), plus
# the whole of grpc_exec_record, which every Exec in that window calls. Comments are
# stripped, because the explanations of this defect name the removed commands.
#
# The `next` after `f=1` matters: awk evaluates every pattern-action rule against a record
# in program order, so without it the SAME line that flips f to 1 would also satisfy the
# later `f{print}` rule and print itself -- including the wall_t0 stamp (and its own
# `date +%s%N`) in a window that is supposed to start strictly after it.
timed_window_body() {
  {
    printf '%s\n' "$(extract_fn run_density_rung)" |
      awk '/wall_t0="/{f=1; next} /wall_t1="/{exit} f{print}'
    extract_fn grpc_exec_record
  } | grep -v '^[[:space:]]*#'
}
tw_body="$(timed_window_body || true)"
check "the timed window is extractable and non-empty" \
  "$([ -n "$tw_body" ] && echo yes || echo no)" "yes"

# NON-VACUOUSNESS: the detector must flag each removed command in a fixture that contains
# it. Without this, "0 findings" below could mean the regex matches nothing.
# python3 joins the list for issue #294. An interpreter startup inside the window is the same
# defect class as the two json_escape interpreters #291 item 2 removed, reintroduced by the fix
# for the spawn they were removed alongside.
#
# SCOPE, stated because it is easy to over-trust: this catches a LITERAL python3 between the
# stamps. It does NOT catch write_rung_plan's call being moved into the window, because that
# call line contains no such token and this guard never expands into the callee's body. The
# branch section below asserts the call site's position directly, and that is the check that
# covers the move.
tw_detect() { printf '%s\n' "$1" | grep -cE '\bjson_escape\b|date \+%s%N|\bmktemp\b|\bwc -l\b|\bpython3\b'; }
check "non-vacuousness: the detector flags a json_escape in the window" \
  "$(tw_detect '  -d "{\"command\":$(json_escape "$cmd\")}"')" "1"
check "non-vacuousness: the detector flags a date +%s%N in the window" \
  "$(tw_detect '  t0="$(date +%s%N)"')" "1"
check "non-vacuousness: the detector flags an mktemp in the window" \
  "$(tw_detect '  err_log="$(mktemp "$E11_TMPDIR/errlog.XXXXXX")"')" "1"
check "non-vacuousness: the detector flags a wc -l loop guard" \
  "$(tw_detect '  while [ "$(wc -l <"$times_file")" -lt "$want" ]; do')" "1"
check "non-vacuousness: the detector flags a literal python3 in the window" \
  "$(tw_detect '  python3 -c "import json"')" "1"
check "scope: the detector does NOT see python3 through a write_rung_plan call" \
  "$(tw_detect '  write_rung_plan "$plan_file" "localhost:8445" "$sandbox_id"')" "0"

if [ -n "$tw_body" ]; then
  check "no json_escape, date, mktemp or wc runs inside the timed window" \
    "$(tw_detect "$tw_body")" "0"
  # The complement, so the check above cannot pass by the window having gone away.
  check "  ...and grpcurl still does (the one spawn that is the measurement)" \
    "$([ "$(printf '%s\n' "$tw_body" | grep -c 'grpcurl')" -ge 1 ] && echo yes || echo no)" "yes"
  check "  ...and latency is stamped from EPOCHREALTIME, a shell variable" \
    "$([ "$(printf '%s\n' "$tw_body" | grep -c 'EPOCHREALTIME')" -ge 1 ] && echo yes || echo no)" "yes"
fi

echo "== grpc_exec_record contains no command substitution at all, arithmetic aside (M10)"
# \$\([^(] matches a command-substitution open, "$(", NOT immediately followed by a second
# "(" -- so it flags "$(cmd)" while leaving "$((expr))" (arithmetic expansion, used for the
# ms computation below) alone. A plain grep for '\$(' would wrongly flag that arithmetic
# expansion too, since "$((" contains "$(" as a substring.
ger_nosubst() { printf '%s\n' "$1" | grep -cE '\$\([^(]'; }
check "non-vacuousness: the detector flags a real command substitution" \
  "$(ger_nosubst 't0="$(date +%s%N)"')" "1"
check "non-vacuousness: the detector does NOT flag arithmetic expansion" \
  "$(ger_nosubst 'us=$(( (10#$b - 10#$a) )); frac=$((1000 + us % 1000)); ms="$((us / 1000)).${frac#1}"')" "0"
ger_body="$(extract_fn grpc_exec_record | grep -v '^[[:space:]]*#' || true)"
check "grpc_exec_record is extractable" "$([ -n "$ger_body" ] && echo yes || echo no)" "yes"
if [ -n "$ger_body" ]; then
  check "  ...and its body runs no command substitution -- not even one avoided fork" \
    "$(ger_nosubst "$ger_body")" "0"
  check "  ...while still using \$((...)) arithmetic expansion for the ms computation" \
    "$([ "$(printf '%s\n' "$ger_body" | grep -cE '\$\(\(')" -ge 1 ] && echo yes || echo no)" "yes"
fi

echo "== epoch_delta_ms and the EPOCHREALTIME preflight"
ep_body="$(extract_fns die epoch_delta_ms set_epoch_ms require_epochrealtime || true)"
check "the epoch helpers are extractable" "$([ -n "$ep_body" ] && echo yes || echo no)" "yes"

if [ -n "$ep_body" ]; then
  ep_snippet="$(mktemp -d)/ep.sh"
  printf '%s\n' "$ep_body" >"$ep_snippet"
  ep() {
    (
      # shellcheck disable=SC1090
      . "$ep_snippet"
      epoch_delta_ms "$1" "$2"
    )
  }
  check "epoch_delta_ms over 1.5s" "$(ep 1789672470.000000 1789672471.500000)" "1500"
  check "epoch_delta_ms truncates sub-millisecond" "$(ep 1789672470.000000 1789672470.000999)" "0"
  check "epoch_delta_ms handles a leading-zero microsecond field" \
    "$(ep 1789672470.000000 1789672470.042000)" "42"
  check "epoch_delta_ms across a second boundary" \
    "$(ep 1789672470.900000 1789672471.100000)" "200"

  # The preflight: a shell with no EPOCHREALTIME (bash < 5.0, which is /bin/bash on macOS)
  # or a locale that renders a decimal comma both make every timed Exec an arithmetic
  # error. This refuses in preflight instead.
  ep_unset_rc=0
  ep_unset_out=$(
    (
      # shellcheck disable=SC1090
      . "$ep_snippet"
      unset EPOCHREALTIME
      require_epochrealtime
    ) 2>&1
  ) || ep_unset_rc=$?
  check "require_epochrealtime refuses when EPOCHREALTIME is unset" \
    "$([ "$ep_unset_rc" -ne 0 ] && echo yes || echo no)" "yes"
  case "$ep_unset_out" in *EPOCHREALTIME*) ep_named=yes ;; *) ep_named=no ;; esac
  check "  ...and the refusal names EPOCHREALTIME" "$ep_named" "yes"
  ep_comma_rc=0
  ep_comma_out=$(
    (
      # shellcheck disable=SC1090
      . "$ep_snippet"
      # EPOCHREALTIME is a bash dynamic variable: per the bash manual, assigning to it
      # while it still has its special properties is ignored on the NEXT read (which
      # keeps returning the live clock, dot-formatted under this suite's LC_ALL=C) --
      # only after `unset` does a plain string assignment actually stick. Without the
      # unset here, this fixture would (mis)report a comma reading as accepted.
      unset EPOCHREALTIME
      EPOCHREALTIME='1789672470,123935'
      require_epochrealtime
    ) 2>&1
  ) || ep_comma_rc=$?
  check "require_epochrealtime refuses a locale decimal COMMA (LC_NUMERIC=de_DE)" \
    "$([ "$ep_comma_rc" -ne 0 ] && echo yes || echo no)" "yes"
  case "$ep_comma_out" in *[Ll]ocale*) ep_loc=yes ;; *) ep_loc=no ;; esac
  check "  ...and says so, so the fix is obvious" "$ep_loc" "yes"
  ep_ok_rc=0
  (
    # shellcheck disable=SC1090
    . "$ep_snippet"
    unset EPOCHREALTIME
    EPOCHREALTIME='1789672470.123935'
    require_epochrealtime
  ) >/dev/null 2>&1 || ep_ok_rc=$?
  check "require_epochrealtime accepts a well-formed reading (does not refuse everything)" \
    "$ep_ok_rc" "0"
  rm -rf "$(dirname "$ep_snippet")"
fi

check "LC_ALL is pinned and exported for the whole driver" \
  "$([ "$(grep -c '^export LC_ALL$' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "preflight calls require_epochrealtime" \
  "$([ "$(printf '%s\n' "$(extract_fn preflight)" | grep -c 'require_epochrealtime')" -ge 1 ] && echo yes || echo no)" "yes"

echo "== preflight only requires docker/pnpm/microVM hardware checks for arms that need them (issue #291 item 5)"
ai_body="$(extract_fn arm_in_use || true)"
check "arm_in_use is extractable" "$([ -n "$ai_body" ] && echo yes || echo no)" "yes"
if [ -n "$ai_body" ]; then
  ai_tmpdir="$(mktemp -d)"
  ai_snippet="$ai_tmpdir/arm_in_use.sh"
  printf '%s\n' "$ai_body" >"$ai_snippet"
  run_arm_in_use() {
    (
      read -r -a E11_ARMS <<<"$2"
      # shellcheck disable=SC1090
      . "$ai_snippet"
      arm_in_use "$1"
    )
  }
  ai_rc=0
  run_arm_in_use container "container driver-control" >/dev/null 2>&1 || ai_rc=$?
  check "arm_in_use finds an arm that IS configured" "$ai_rc" "0"
  ai_rc=0
  run_arm_in_use microvm "container driver-control" >/dev/null 2>&1 || ai_rc=$?
  check "  ...and refuses (nonzero) one that is NOT configured" \
    "$([ "$ai_rc" -ne 0 ] && echo yes || echo no)" "yes"
  rm -rf "$ai_tmpdir"
fi

pf_body="$(extract_fn preflight || true)"
check "preflight is extractable" "$([ -n "$pf_body" ] && echo yes || echo no)" "yes"
if [ -n "$pf_body" ]; then
  # Strip full-line comments first: this file's own header comments say "check_kvm" and
  # "validate_arms" while explaining the ordering, which would otherwise satisfy grep -n
  # before the real code line does and silently defeat the ordering assertions below.
  pf_code="$(printf '%s\n' "$pf_body" | grep -v '^[[:space:]]*#')"
  pf_line() { printf '%s\n' "$pf_code" | grep -n -- "$1" | head -n1 | cut -d: -f1; }
  pf_validate="$(pf_line 'validate_arms')"
  pf_guard="$(pf_line 'arm_in_use container')"
  pf_docker="$(pf_line 'require_tool docker')"
  pf_pnpm="$(pf_line 'require_tool pnpm')"
  pf_vmm_guard="$(pf_line 'arm_in_use microvm')"
  pf_kvm="$(pf_line 'check_kvm')"
  check "validate_arms runs before any arm-conditional check reads E11_ARMS" \
    "$([ -n "$pf_validate" ] && [ -n "$pf_guard" ] && [ "$pf_validate" -lt "$pf_guard" ] && echo yes || echo no)" "yes"
  check "docker is required only inside an arm_in_use(container|microvm) guard" \
    "$([ -n "$pf_docker" ] && [ -n "$pf_guard" ] && [ "$pf_guard" -lt "$pf_docker" ] && echo yes || echo no)" "yes"
  check "pnpm is required only inside that same guard" \
    "$([ -n "$pf_pnpm" ] && [ -n "$pf_guard" ] && [ "$pf_guard" -lt "$pf_pnpm" ] && echo yes || echo no)" "yes"
  check "check_kvm is required only inside an arm_in_use(microvm) guard" \
    "$([ -n "$pf_kvm" ] && [ -n "$pf_vmm_guard" ] && [ "$pf_vmm_guard" -lt "$pf_kvm" ] && echo yes || echo no)" "yes"
  check "  ...and so are check_cgroups/check_swap/check_governor (all four gated together)" \
    "$(printf '%s\n' "$pf_code" | awk '/arm_in_use microvm/{f=1} f' | grep -cE '^\s*(check_kvm|check_cgroups|check_swap|GOVERNOR_STATE="\$\(check_governor\)")$')" "4"
  check "grpcurl and go stay unconditional -- every arm needs both" \
    "$(printf '%s\n' "$pf_code" | grep -cE '^\s*require_tool (grpcurl|go) ')" "2"
fi
check "the slot's error log is a fixed path under the trap-owned root, not an mktemp" \
  "$([ "$(grep -c 'err_log="\$slot_dir/slot-\$i.err"' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
# Spec section 1 says the escaping happens BEFORE TIMING STARTS, not merely outside the
# per-Exec loop. Assert the order structurally: the mix is escaped, and every slot's
# workspace_key with it, above the wall_t0 stamp.
pe_rdr="$(extract_fn run_density_rung || true)"
if [ -n "$pe_rdr" ]; then
  pe_line() { printf '%s\n' "$pe_rdr" | grep -n -- "$1" | head -n1 | cut -d: -f1; }
  pe_mix="$(pe_line 'mapfile -t mix_json')"
  pe_ws="$(pe_line 'ws_json_by_slot\[i\]=')"
  pe_t0="$(pe_line 'wall_t0="')"
  check "the mix is pre-escaped inside run_density_rung" \
    "$([ -n "$pe_mix" ] && echo yes || echo no)" "yes"
  check "each slot's workspace_key is pre-escaped too" \
    "$([ -n "$pe_ws" ] && echo yes || echo no)" "yes"
  if [ -n "$pe_mix" ] && [ -n "$pe_ws" ] && [ -n "$pe_t0" ]; then
    check "the mix is escaped BEFORE wall_t0 (before timing starts)" \
      "$([ "$pe_mix" -lt "$pe_t0" ] && echo yes || echo no)" "yes"
    check "the workspace keys are escaped before wall_t0 too" \
      "$([ "$pe_ws" -lt "$pe_t0" ] && echo yes || echo no)" "yes"
  fi
  check "the mix is escaped exactly once per rung, not once per slot" \
    "$(printf '%s\n' "$pe_rdr" | grep -c 'mapfile -t mix_json')" "1"
fi

# ---------------------------------------------------------------------------
# Issue #291 item 1: host resource signals are sampled DURING the timed window.
#
# host_signals_snapshot was called after every slot subshell had exited and after the
# throughput window closed, and host_cpu_fraction then SLEPT ONE SECOND and diffed
# /proc/stat across that window -- so hostCpuFraction, memAvailableBytes and pssBytes all
# described a quiesced machine. The recorded values contain their own falsification: 0.0006
# on a 72-cpu host is 0.043 cores busy, while the same rung sustained ~41 Exec/sec at ~9
# spawns each, on the order of 370 process creations per second.
#
# Worse than weak: crosses('cpu') in experiments/src/microvm-density.ts reads
# hostCpuFraction >= 0.9, so a post-load 0.0006 makes the `cpu` bound STRUCTURALLY unable to
# fire at any rung. EXPERIMENTS.md's "no CPU ceiling was reached" is a restatement of the
# sampling bug, not a finding.
#
# The sampler that replaces it must not become the next artifact: reading 128 smaps_rollup
# files per second while measuring a density ceiling perturbs the thing under test. So the
# every-tick path uses only builtins, and the pgrep + N-file walk runs every Nth tick.
# ---------------------------------------------------------------------------
echo "== the sampler's every-tick path uses only builtins (#291 item 1)"

samp_body="$(extract_fns die set_epoch_ms discover_pids pss_bytes_for_pids proc_stat_totals proc_meminfo_available host_sampler_tick host_sampler_loop || true)"
# The concatenated extract_fns form above is only a strengthened guard when paired with the
# single-name form: extract_fns PRINTS each function's body as it walks the list and only
# FAILS at the first MISSING name, so bodies from functions that landed in earlier tasks
# (die, set_epoch_ms, discover_pids, pss_bytes_for_pids) would keep $samp_body non-empty
# even if every sampler-specific name below were absent. extract_fn on a single sampler
# name has no such earlier-landed name to hide behind: it is empty if and only if that
# function does not exist.
samp_tick_solo="$(extract_fn host_sampler_tick || true)"
check "host_sampler_tick alone is extractable (a guard extract_fns cannot fake)" \
  "$([ -n "$samp_tick_solo" ] && echo yes || echo no)" "yes"
# Symmetric with the host_sampler_tick guard above: extract_fns prints each body as it
# walks its name list and only fails at the first MISSING name, so a same-list check stays
# non-empty even if the LAST-named function (host_sampler_loop) is absent. A standalone
# extract_fn on that name alone has no earlier-landed name to hide behind.
samp_loop_solo="$(extract_fn host_sampler_loop || true)"
check "host_sampler_loop alone is extractable (a guard extract_fns cannot fake)" \
  "$([ -n "$samp_loop_solo" ] && echo yes || echo no)" "yes"
check "the sampler functions are extractable" "$([ -n "$samp_body" ] && echo yes || echo no)" "yes"

# The every-tick path must contain no external command. awk, sleep, date, pgrep, python3 and
# wc are all forks; `sleep` is legitimate in host_sampler_loop's slice wait but must not
# appear in the tick itself, and pgrep/awk reach the tick only through the low-cadence
# branch, which is guarded.
tick_only="$(extract_fn host_sampler_tick | grep -v '^[[:space:]]*#' || true)"
check "host_sampler_tick body is extractable" "$([ -n "$tick_only" ] && echo yes || echo no)" "yes"
tick_forks() { printf '%s\n' "$1" | grep -cE '\bawk\b|\bsleep\b|date \+|\bpython3\b|\bwc\b|\bcat\b'; }
check "non-vacuousness: the fork detector flags an awk in a tick" \
  "$(tick_forks '  frac="$(awk -v x=1 "BEGIN{print x}")"')" "1"
if [ -n "$tick_only" ]; then
  check "host_sampler_tick calls no awk, sleep, date, python3, wc or cat" \
    "$(tick_forks "$tick_only")" "0"
  check "  ...and formats the CPU fraction with printf -v (a builtin, not a subshell)" \
    "$([ "$(printf '%s\n' "$tick_only" | grep -c 'printf -v')" -ge 1 ] && echo yes || echo no)" "yes"
  check "  ...and the pgrep walk is behind the low-cadence guard, not on every tick" \
    "$([ "$(printf '%s\n' "$tick_only" | grep -c 'SAMPLE_LOW_EVERY')" -ge 1 ] && echo yes || echo no)" "yes"
fi

if [ -n "$samp_body" ]; then
  sp_tmpdir="$(mktemp -d)"
  sp_snippet="$sp_tmpdir/samp.sh"
  printf '%s\n' "$samp_body" >"$sp_snippet"
  sp_proc="$sp_tmpdir/proc"
  mkdir -p "$sp_proc"

  # --- CPU diff correctness, against two hand-written /proc/stat snapshots.
  # Snapshot A: user=100 nice=0 system=100 idle=800 iowait=0, total 1000, idle+iowait 800.
  # Snapshot B: user=600 nice=0 system=100 idle=1300 iowait=0, total 2000, idle+iowait 1300.
  # dt=1000, di=500 -> busy fraction 1 - 500/1000 = 0.5000.
  printf 'cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 100 0 100 800 0 0 0 0 0 0\n' >"$sp_proc/stat"
  printf 'MemTotal:       16384000 kB\nMemFree:            1000 kB\nMemAvailable:    8192000 kB\n' >"$sp_proc/meminfo"

  sp_line=$(
    PROC_ROOT="$sp_proc"
    SAMPLE_LOW_EVERY=1000 # so tick 1 takes the LOW-cadence branch only if tick==1 forces it
    VMM_PROC_PATTERN="__e11_no_such_process__"
    VIRTIOFSD_PROC_PATTERN="__e11_no_such_process__"
    # shellcheck disable=SC1090
    . "$sp_snippet"
    proc_stat_totals
    # shellcheck disable=SC2154 # assigned by proc_stat_totals, sourced above
    SAMPLE_PREV_IDLE="$SAMPLE_IDLE"
    # shellcheck disable=SC2154
    SAMPLE_PREV_TOTAL="$SAMPLE_TOTAL"
    SAMPLE_TICK=0 # the script-scope declaration is not in the extracted snippet
    printf 'cpu  600 0 100 1300 0 0 0 0 0 0\ncpu0 600 0 100 1300 0 0 0 0 0 0\n' >"$PROC_ROOT/stat"
    host_sampler_tick "$sp_tmpdir/out"
    cat "$sp_tmpdir/out"
  )
  check "the CPU diff over two hand-written /proc/stat snapshots is 0.5000" \
    "$(printf '%s\n' "$sp_line" | awk '{print $1}')" "0.5000"
  check "MemAvailable is parsed from a fake /proc/meminfo and converted to bytes" \
    "$(printf '%s\n' "$sp_line" | awk '{print $2}')" "8388608000"
  check "the tick emits exactly one line" "$(printf '%s\n' "$sp_line" | wc -l | tr -d ' ')" "1"
  rm -f "$sp_tmpdir/out"

  # --- A zero-delta snapshot pair is 0.0000, not a division by zero.
  printf 'cpu  100 0 100 800 0 0 0 0 0 0\n' >"$sp_proc/stat"
  sp_zero=$(
    PROC_ROOT="$sp_proc"
    SAMPLE_LOW_EVERY=1000
    VMM_PROC_PATTERN="__e11_no_such_process__"
    VIRTIOFSD_PROC_PATTERN="__e11_no_such_process__"
    # shellcheck disable=SC1090
    . "$sp_snippet"
    proc_stat_totals
    SAMPLE_PREV_IDLE="$SAMPLE_IDLE"
    SAMPLE_PREV_TOTAL="$SAMPLE_TOTAL"
    SAMPLE_TICK=0 # the script-scope declaration is not in the extracted snippet
    host_sampler_tick "$sp_tmpdir/out"
    awk '{print $1}' "$sp_tmpdir/out"
  )
  check "an identical snapshot pair yields 0.0000, not a divide-by-zero" "$sp_zero" "0.0000"
  rm -f "$sp_tmpdir/out"

  # --- A fully busy window is 1.0000 and never exceeds it.
  printf 'cpu  100 0 100 800 0 0 0 0 0 0\n' >"$sp_proc/stat"
  sp_busy=$(
    PROC_ROOT="$sp_proc"
    SAMPLE_LOW_EVERY=1000
    VMM_PROC_PATTERN="__e11_no_such_process__"
    VIRTIOFSD_PROC_PATTERN="__e11_no_such_process__"
    # shellcheck disable=SC1090
    . "$sp_snippet"
    proc_stat_totals
    SAMPLE_PREV_IDLE="$SAMPLE_IDLE"
    SAMPLE_PREV_TOTAL="$SAMPLE_TOTAL"
    SAMPLE_TICK=0 # the script-scope declaration is not in the extracted snippet
    printf 'cpu  1100 0 100 800 0 0 0 0 0 0\n' >"$PROC_ROOT/stat"
    host_sampler_tick "$sp_tmpdir/out"
    awk '{print $1}' "$sp_tmpdir/out"
  )
  check "a window with zero idle jiffies is 1.0000 (the value crosses('cpu') tests at 0.9)" \
    "$sp_busy" "1.0000"
  rm -f "$sp_tmpdir/out"

  # --- No MemAvailable line: 0, and still one clean line (the H2 class, in the sampler).
  printf 'MemTotal:       16384000 kB\n' >"$sp_proc/meminfo"
  printf 'cpu  100 0 100 800 0 0 0 0 0 0\n' >"$sp_proc/stat"
  sp_nomem=$(
    PROC_ROOT="$sp_proc"
    SAMPLE_LOW_EVERY=1000
    VMM_PROC_PATTERN="__e11_no_such_process__"
    VIRTIOFSD_PROC_PATTERN="__e11_no_such_process__"
    # shellcheck disable=SC1090
    . "$sp_snippet"
    proc_stat_totals
    SAMPLE_PREV_IDLE="$SAMPLE_IDLE"
    SAMPLE_PREV_TOTAL="$SAMPLE_TOTAL"
    SAMPLE_TICK=0 # the script-scope declaration is not in the extracted snippet
    host_sampler_tick "$sp_tmpdir/out"
    cat "$sp_tmpdir/out"
  )
  check "no MemAvailable line -> 0 bytes, on one line" \
    "$(printf '%s\n' "$sp_nomem" | awk '{print $2}')" "0"
  check "  ...and still exactly one line (no two-line value, the H2 shape)" \
    "$(printf '%s\n' "$sp_nomem" | wc -l | tr -d ' ')" "1"
  printf 'MemTotal:       16384000 kB\nMemFree:            1000 kB\nMemAvailable:    8192000 kB\n' >"$sp_proc/meminfo"
  rm -f "$sp_tmpdir/out"

  # --- The low cadence: tick 1 always carries pss/processCount (so a rung can never end
  # with zero of them while having CPU samples), then every SAMPLE_LOW_EVERY'th tick.
  sp_marker="$(marker_token sampler)"
  spawn_marker_process "$sp_marker"
  sp_live="$MARKER_PID"
  mkdir -p "$sp_proc/$sp_live"
  printf 'Pss:                 512 kB\n' >"$sp_proc/$sp_live/smaps_rollup"
  sp_cad=$(
    PROC_ROOT="$sp_proc"
    SAMPLE_LOW_EVERY=3
    VMM_PROC_PATTERN="$sp_marker"
    VIRTIOFSD_PROC_PATTERN="__e11_no_such_process__"
    # shellcheck disable=SC1090
    . "$sp_snippet"
    proc_stat_totals
    # shellcheck disable=SC2034
    SAMPLE_PREV_IDLE="$SAMPLE_IDLE"
    # shellcheck disable=SC2034
    SAMPLE_PREV_TOTAL="$SAMPLE_TOTAL"
    # shellcheck disable=SC2034 # the script-scope declaration is not in the extracted snippet
    SAMPLE_TICK=0 # the script-scope declaration is not in the extracted snippet
    for _ in 1 2 3 4 5 6; do host_sampler_tick "$sp_tmpdir/out"; done
    awk '{print $3}' "$sp_tmpdir/out" | tr '\n' ' '
  )
  check "tick 1 carries pssBytes, then every 3rd tick does (ticks 1,3,6 of 6)" \
    "$sp_cad" "524288 - 524288 - - 524288 "
  sp_cad_proc=$(awk '{print $4}' "$sp_tmpdir/out" | tr '\n' ' ')
  check "  ...and processCount follows the same cadence" "$sp_cad_proc" "1 - 1 - - 1 "
  stop_marker_process "$sp_live"
  rm -f "$sp_tmpdir/out"

  # --- host_sampler_loop: ticks while running, stops on the stop file, and emits a final
  # tick so a short rung is not left with zero samples.
  printf 'cpu  100 0 100 800 0 0 0 0 0 0\n' >"$sp_proc/stat"
  sp_stop="$sp_tmpdir/stop"
  sp_out="$sp_tmpdir/loop-out"
  : >"$sp_out"
  (
    PROC_ROOT="$sp_proc"
    SAMPLE_INTERVAL_MS=200
    SAMPLE_SLICE_MS=100
    SAMPLE_MIN_TICK_MS=1
    SAMPLE_LOW_EVERY=1000
    VMM_PROC_PATTERN="__e11_no_such_process__"
    VIRTIOFSD_PROC_PATTERN="__e11_no_such_process__"
    # shellcheck disable=SC1090
    . "$sp_snippet"
    host_sampler_loop "$sp_out" "$sp_stop"
  ) &
  sp_loop_pid=$!
  sleep 1
  : >"$sp_stop"
  wait "$sp_loop_pid"
  sp_n="$(wc -l <"$sp_out" | tr -d ' ')"
  check "host_sampler_loop produced at least 3 ticks in ~1s at a 200ms interval" \
    "$([ "$sp_n" -ge 3 ] && echo yes || echo no)" "yes"
  check "  ...and exited on the stop file rather than running forever" \
    "$([ -e "/proc/$sp_loop_pid" ] && echo running || echo exited)" "exited"
  check "  ...and every line has exactly 4 fields" \
    "$(awk 'NF != 4 {bad++} END{print bad+0}' "$sp_out")" "0"

  # A rung shorter than one interval still gets one sample, from the stop tick.
  : >"$sp_out"
  rm -f "$sp_stop"
  (
    PROC_ROOT="$sp_proc"
    SAMPLE_INTERVAL_MS=60000
    SAMPLE_SLICE_MS=100
    SAMPLE_MIN_TICK_MS=1
    SAMPLE_LOW_EVERY=1000
    VMM_PROC_PATTERN="__e11_no_such_process__"
    VIRTIOFSD_PROC_PATTERN="__e11_no_such_process__"
    # shellcheck disable=SC1090
    . "$sp_snippet"
    host_sampler_loop "$sp_out" "$sp_stop"
  ) &
  sp_short_pid=$!
  sleep 0.5
  : >"$sp_stop"
  wait "$sp_short_pid"
  check "a window shorter than one interval still yields one sample (the stop tick)" \
    "$(wc -l <"$sp_out" | tr -d ' ')" "1"

  # ...but the stop tick REFUSES to fabricate a sample over an interval too short to diff.
  : >"$sp_out"
  rm -f "$sp_stop"
  (
    PROC_ROOT="$sp_proc"
    # shellcheck disable=SC2034
    SAMPLE_INTERVAL_MS=60000
    # shellcheck disable=SC2034
    SAMPLE_SLICE_MS=100
    # shellcheck disable=SC2034
    SAMPLE_MIN_TICK_MS=60000
    # shellcheck disable=SC2034 # read by host_sampler_loop once sourced
    SAMPLE_LOW_EVERY=1000
    VMM_PROC_PATTERN="__e11_no_such_process__"
    VIRTIOFSD_PROC_PATTERN="__e11_no_such_process__"
    # shellcheck disable=SC1090
    . "$sp_snippet"
    host_sampler_loop "$sp_out" "$sp_stop"
  ) &
  sp_tiny_pid=$!
  sleep 0.4
  : >"$sp_stop"
  wait "$sp_tiny_pid"
  check "a window below SAMPLE_MIN_TICK_MS records NO sample rather than a noise diff" \
    "$(wc -l <"$sp_out" | tr -d ' ')" "0"

  # A rung that has ALREADY landed a real full-interval tick gets no diluted extra sample at
  # stop, even when SAMPLE_MIN_TICK_MS is tiny enough that the elapsed-time floor alone would
  # otherwise let one through (issue #291 item 2). SAMPLE_MIN_TICK_MS=1 here is deliberate: it
  # isolates the SAMPLE_TICK==0 gate as the ONLY thing standing between "at least one full tick
  # already landed" and an extra stop-tick, so a regression that drops that gate turns this
  # into a failure rather than passing by an unrelated floor.
  #
  # host_sampler_loop checks for the stop file only once per SLICE, at the top of its loop,
  # BEFORE it sleeps -- so if the stop file appears while a slice's sleep is already in
  # flight, that slice (and, if it is the last slice of a tick group, the tick that goes with
  # it) still completes; the loop only notices stop on its NEXT top-of-loop check. A fixed
  # "sleep N then write stop" cannot dodge that: whatever N is, there is no way to guarantee
  # the write lands in the brief gap right after a tick rather than mid-slice. So instead of
  # guessing a delay, POLL for the first tick to land and write the stop file within one poll
  # tick of seeing it -- that reaction is a handful of the loop's own SAMPLE_SLICE_MS slices
  # away from the second tick, giving a wide, timing-independent margin against mistaking a
  # legitimately-scheduled second tick for the dilution bug this checks for.
  : >"$sp_out"
  rm -f "$sp_stop"
  (
    PROC_ROOT="$sp_proc"
    # shellcheck disable=SC2034
    SAMPLE_INTERVAL_MS=1000
    # shellcheck disable=SC2034
    SAMPLE_SLICE_MS=200
    # shellcheck disable=SC2034
    SAMPLE_MIN_TICK_MS=1
    # shellcheck disable=SC2034 # read by host_sampler_loop once sourced
    SAMPLE_LOW_EVERY=1000
    VMM_PROC_PATTERN="__e11_no_such_process__"
    VIRTIOFSD_PROC_PATTERN="__e11_no_such_process__"
    # shellcheck disable=SC1090
    . "$sp_snippet"
    host_sampler_loop "$sp_out" "$sp_stop"
  ) &
  sp_dil_pid=$!
  sp_before=0
  for _ in $(seq 1 400); do
    sp_before="$(wc -l <"$sp_out" | tr -d ' ')"
    [ "$sp_before" -ge 1 ] && break
    sleep 0.02
  done
  : >"$sp_stop"
  wait "$sp_dil_pid"
  sp_after="$(wc -l <"$sp_out" | tr -d ' ')"
  check "at least one full tick landed before stop was signalled (scenario sanity check)" \
    "$([ "$sp_before" -ge 1 ] && echo yes || echo no)" "yes"
  check "no diluted extra tick is appended once a full tick has already landed" \
    "$sp_after" "$sp_before"

  rm -rf "$sp_tmpdir"
fi

echo "== sampler_field's arithmetic over a fixed synthetic sample file (#291 item 1)"
sf_body="$(extract_fns sampler_field host_cpu_count || true)"
check "sampler_field and host_cpu_count are extractable" \
  "$([ -n "$sf_body" ] && echo yes || echo no)" "yes"

if [ -n "$sf_body" ]; then
  sf_tmpdir="$(mktemp -d)"
  sf_snippet="$sf_tmpdir/sf.sh"
  printf '%s\n' "$sf_body" >"$sf_snippet"
  # Three ticks. Ticks 1 and 3 carry the low-cadence signals; tick 2 does not, and its "-"
  # cells must be SKIPPED rather than read as zero -- a 0 in a mean is a claim, an absent
  # sample is not.
  sf_file="$sf_tmpdir/samples"
  {
    echo '0.1000 8000000000 524288 2'
    echo '0.5000 4000000000 - -'
    echo '0.9000 6000000000 1048576 4'
  } >"$sf_file"
  sf() {
    (
      # shellcheck disable=SC1090
      . "$sf_snippet"
      sampler_field "$sf_file" "$1" "$2" "${3:-%.4f}"
    )
  }
  check "cpu mean over 3 ticks" "$(sf 1 mean)" "0.5000"
  check "cpu peak" "$(sf 1 peak)" "0.9000"
  check "cpu min" "$(sf 1 min)" "0.1000"
  check "cpu sample count" "$(sf 1 count '%d')" "3"
  check "memAvailable mean, as an integer" "$(sf 2 mean '%.0f')" "6000000000"
  check "memAvailable min (the only extreme that can indicate pressure)" "$(sf 2 min '%.0f')" "4000000000"
  check "pss mean SKIPS the '-' tick (2 samples, not 3)" "$(sf 3 mean '%.0f')" "786432"
  check "pss peak" "$(sf 3 peak '%.0f')" "1048576"
  check "pss sample count is 2, exposing the reduced cadence" "$(sf 3 count '%d')" "2"
  check "processCount mean, rounded to an integer" "$(sf 4 mean '%.0f')" "3"
  check "processCount peak" "$(sf 4 peak '%.0f')" "4"
  check "processCount sample count" "$(sf 4 count '%d')" "2"

  # An empty file is the ABSENCE of a measurement, not a zero -- same refusal shape as
  # percentile. count prints 0 so the caller can distinguish "no samples" from "failed".
  sf_empty="$sf_tmpdir/empty"
  : >"$sf_empty"
  sf_empty_rc=0
  (
    # shellcheck disable=SC1090
    . "$sf_snippet"
    sampler_field "$sf_empty" 1 mean '%.4f'
  ) >/dev/null 2>&1 || sf_empty_rc=$?
  check "an empty sample file is a refusal, not a 0.0000 mean" \
    "$([ "$sf_empty_rc" -ne 0 ] && echo yes || echo no)" "yes"

  # A column that is "-" on EVERY tick is likewise absent, not zero.
  sf_alldash="$sf_tmpdir/alldash"
  printf '0.1000 8000000000 - -\n0.2000 8000000000 - -\n' >"$sf_alldash"
  sf_dash_rc=0
  (
    # shellcheck disable=SC1090
    . "$sf_snippet"
    sampler_field "$sf_alldash" 3 mean '%.0f'
  ) >/dev/null 2>&1 || sf_dash_rc=$?
  check "an all-'-' column is a refusal too" \
    "$([ "$sf_dash_rc" -ne 0 ] && echo yes || echo no)" "yes"
  sf_dash_count=$(
    # shellcheck disable=SC1090
    . "$sf_snippet"
    sampler_field "$sf_alldash" 3 count '%d'
  )
  check "  ...while its count is 0, which is what the record shows" "$sf_dash_count" "0"

  sf_ncpu=$(
    # shellcheck disable=SC1090
    . "$sf_snippet"
    host_cpu_count
  )
  check "host_cpu_count prints a positive integer (coresBusy = mean x this)" \
    "$([ "$sf_ncpu" -ge 1 ] 2>/dev/null && echo yes || echo no)" "yes"

  rm -rf "$sf_tmpdir"
fi

echo "== a refused PSS read is counted, not silently dropped like an ordinary '-' tick (#291 item 4)"
smc_body="$(extract_fns sampler_field sampler_marker_count || true)"
check "sampler_field and sampler_marker_count are extractable" \
  "$([ -n "$smc_body" ] && echo yes || echo no)" "yes"
if [ -n "$smc_body" ]; then
  smc_tmpdir="$(mktemp -d)"
  smc_snippet="$smc_tmpdir/smc.sh"
  printf '%s\n' "$smc_body" >"$smc_snippet"
  # Five ticks in column 3 (pssBytes): one real reading, one ordinary un-sampled "-", two
  # DISTINCT refusals (pss_bytes_for_pids died on an unreadable smaps_rollup), and one more
  # real reading -- so pssRefusedTicks (refused=2) must differ from both pssSamples
  # (sampler_field count=2, the two numeric ticks) and from a naive "non-dash" count (which
  # would wrongly fold the refusals in as if they were data).
  smc_file="$smc_tmpdir/samples"
  {
    echo '0.1000 8000000000 524288 2'
    echo '0.2000 8000000000 - -'
    echo '0.3000 8000000000 refused -'
    echo '0.4000 8000000000 refused -'
    echo '0.5000 8000000000 1048576 4'
  } >"$smc_file"
  smc() {
    (
      # shellcheck disable=SC1090
      . "$smc_snippet"
      "$@"
    )
  }
  check "pssRefusedTicks counts exactly the 'refused' markers, via sampler_marker_count" \
    "$(smc sampler_marker_count "$smc_file" 3 refused)" "2"
  check "  ...and a marker no tick actually holds counts zero, not an error" \
    "$(smc sampler_marker_count "$smc_file" 3 no-such-marker)" "0"
  check "  ...an empty sampler file also counts zero refusals rather than failing" \
    "$(smc sampler_marker_count "$smc_tmpdir/does-not-exist" 3 refused)" "0"
  check "pssSamples (sampler_field count) is 2 -- the refusals are NOT folded in as data" \
    "$(smc sampler_field "$smc_file" 3 count '%d')" "2"
  check "  ...and pssBytes' mean is over only those 2 real readings, refusals excluded" \
    "$(smc sampler_field "$smc_file" 3 mean '%.0f')" "786432"
  rm -rf "$smc_tmpdir"
fi

echo "== the sampler brackets exactly the timed window, and nothing else (#291 item 1)"
sw_rdr="$(extract_fn run_density_rung || true)"
if [ -n "$sw_rdr" ]; then
  sw_line() { printf '%s\n' "$sw_rdr" | grep -n -- "$1" | head -n1 | cut -d: -f1; }
  sw_t0="$(sw_line 'wall_t0="')"
  sw_start="$(sw_line 'host_sampler_loop ')"
  sw_t1="$(sw_line 'wall_t1="')"
  sw_snap="$(sw_line 'host_signals_snapshot "\$require_vmm"')"
  check "the sampler is started inside run_density_rung" \
    "$([ -n "$sw_start" ] && echo yes || echo no)" "yes"
  if [ -n "$sw_t0" ] && [ -n "$sw_start" ] && [ -n "$sw_t1" ]; then
    check "the sampler starts AFTER wall_t0 (never before the window it describes)" \
      "$([ "$sw_t0" -lt "$sw_start" ] && echo yes || echo no)" "yes"
    check "the sampler starts BEFORE the first Exec is issued" \
      "$([ "$sw_start" -lt "$(sw_line 'grpc_exec_record ')" ] && echo yes || echo no)" "yes"
  fi
  if [ -n "$sw_t1" ] && [ -n "$sw_snap" ]; then
    check "the post-load snapshot is still taken, AFTER wall_t1" \
      "$([ "$sw_t1" -lt "$sw_snap" ] && echo yes || echo no)" "yes"
  fi
  check "the sampler is reaped before aggregation (a wait on its pid)" \
    "$([ "$(printf '%s\n' "$sw_rdr" | grep -c 'wait "\$E11_SAMPLER_PID"')" -ge 1 ] && echo yes || echo no)" "yes"
fi
check "hostCpuFraction is recorded from the sampler's MEAN, not the post-load snapshot" \
  "$([ "$(grep -c "'hostCpuFraction': \$cpu_mean," "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "the post-load snapshot keeps its own four explicitly named fields" \
  "$(grep -cE "'postLoad(HostCpuFraction|MemAvailableBytes|PssBytes|ProcessCount)':" "$SCRIPT")" "4"
check "samplingMode marks these records so they cannot be compared with pre-fix ones" \
  "$(grep -c "'samplingMode': 'in-rung-1hz-mean'," "$SCRIPT")" "1"
check "the reduced PSS/processCount cadence is disclosed in proxyLimitations" \
  "$([ "$(grep -c 'sampled every .* sampler tick' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "a rung with zero host samples is REFUSED, not backfilled from the idle snapshot" \
  "$([ "$(grep -c 'produced ZERO host samples over its timed window' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "standbysResident is derived from the SAMPLED process count, not the post-load one" \
  "$([ "$(grep -c 'standbys_resident=\$((proc_mean > c' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "the sampler is killed from the EXIT trap, so a die mid-rung cannot orphan it" \
  "$([ "$(printf '%s\n' "$(extract_fn cleanup_on_exit)" | grep -c 'stop_host_sampler')" -ge 1 ] && echo yes || echo no)" "yes"

# ---------------------------------------------------------------------------
# Issue #291 item 3: converge is out of the throughput denominator.
#
# wall_t0 was stamped, then each slot ran converge_slot -- a git fetch -- and only then its
# Exec loop, and wall_t1 closed after all of it. throughput = successful Execs / wall
# seconds, so a slow fetch WAS a throughput ceiling, on both arms, by construction. The
# header's claim that converge is timed separately was true only of p50/p95.
#
# run_density_rung now runs two phases with a full drain between them. Each slot's run_id,
# workspace_key and req_base are deterministic in (arm, d, ram_mb, c, i), so phase 2
# recomputes them and lands on the workspace phase 1 prepared, and req_id spaces stay
# disjoint across the barrier.
# ---------------------------------------------------------------------------
echo "== the timed window starts AFTER every slot has converged (#291 item 3)"

bar_rdr="$(extract_fn run_density_rung || true)"
check "run_density_rung is still extractable after the phase split" \
  "$([ -n "$bar_rdr" ] && echo yes || echo no)" "yes"

if [ -n "$bar_rdr" ]; then
  bar_line() { printf '%s\n' "$bar_rdr" | grep -n -- "$1" | head -n1 | cut -d: -f1; }
  bar_conv="$(bar_line 'converge_slot ')"
  bar_conv_wait="$(bar_line 'wait "\$pid" || converge_failures=')"
  bar_t0="$(bar_line 'wall_t0="')"
  bar_exec="$(bar_line 'grpc_exec_record ')"
  bar_t1="$(bar_line 'wall_t1="')"
  for pair in "converge_slot:$bar_conv" "converge wait:$bar_conv_wait" "wall_t0:$bar_t0" \
    "grpc_exec_record:$bar_exec" "wall_t1:$bar_t1"; do
    check "the ${pair%%:*} line is present in run_density_rung" \
      "$([ -n "${pair##*:}" ] && echo yes || echo no)" "yes"
  done
  if [ -n "$bar_conv" ] && [ -n "$bar_conv_wait" ] && [ -n "$bar_t0" ] && [ -n "$bar_exec" ] && [ -n "$bar_t1" ]; then
    check "converge_slot runs before the converge phase is drained" \
      "$([ "$bar_conv" -lt "$bar_conv_wait" ] && echo yes || echo no)" "yes"
    check "the converge phase is drained BEFORE wall_t0 is stamped (the barrier)" \
      "$([ "$bar_conv_wait" -lt "$bar_t0" ] && echo yes || echo no)" "yes"
    check "wall_t0 is stamped before the first Exec is issued" \
      "$([ "$bar_t0" -lt "$bar_exec" ] && echo yes || echo no)" "yes"
    check "wall_t1 closes after the last Exec" \
      "$([ "$bar_exec" -lt "$bar_t1" ] && echo yes || echo no)" "yes"
    check "no converge_slot call remains between wall_t0 and wall_t1" \
      "$(printf '%s\n' "$bar_rdr" | awk -v a="$bar_t0" -v b="$bar_t1" 'NR>a && NR<b' | grep -c 'converge_slot ')" "0"
  fi
  check "both phases derive the run id from ONE helper, so they cannot drift" \
    "$(printf '%s\n' "$bar_rdr" | grep -c 'slot_run_id ')" "2"
  # Three call sites since issue #294's Go plan: converge, the timed loop, and the
  # plan-building loop that feeds write_rung_plan's reqBase -- all deriving from the
  # SAME helper, so they cannot drift from each other.
  check "all call sites derive the req_id base from ONE helper" \
    "$(printf '%s\n' "$bar_rdr" | grep -c 'slot_req_base ')" "3"
fi

echo "== the slot-identity helpers are deterministic in (arm, d, ram_mb, c, i)"
id_body="$(extract_fns slot_run_id slot_workspace_key slot_req_base || true)"
check "the slot-identity helpers are extractable" \
  "$([ -n "$id_body" ] && echo yes || echo no)" "yes"
if [ -n "$id_body" ]; then
  id_snippet="$(mktemp -d)/id.sh"
  printf '%s\n' "$id_body" >"$id_snippet"
  idf() {
    (
      # shellcheck disable=SC1090
      . "$id_snippet"
      "$@"
    )
  }
  check "slot_run_id is the documented shape" \
    "$(idf slot_run_id microvm 2 256 8 3)" "e11-microvm-d2-ram256-c8-slot3"
  check "slot_run_id is deterministic (same args, same id)" \
    "$([ "$(idf slot_run_id microvm 2 256 8 3)" = "$(idf slot_run_id microvm 2 256 8 3)" ] && echo yes || echo no)" "yes"
  check "slot_run_id distinguishes slots, so two slots cannot share a workspace" \
    "$([ "$(idf slot_run_id microvm 2 256 8 3)" != "$(idf slot_run_id microvm 2 256 8 4)" ] && echo yes || echo no)" "yes"
  check "the microvm arm gets a non-empty workspace_key (it REFUSES an empty one)" \
    "$(idf slot_workspace_key microvm e11-x-slot1)" "e11-x-slot1"
  check "the container arm gets an empty workspace_key (today's shared workspace)" \
    "$(idf slot_workspace_key container e11-x-slot1)" ""
  check "the driver-control arm follows the container path" \
    "$(idf slot_workspace_key driver-control e11-x-slot1)" ""
  check "slot_req_base spaces slots a million apart" "$(idf slot_req_base 3)" "3000000"
  check "  ...so no two slots' req_id ranges can overlap at any sane ITERS_PER_SLOT" \
    "$([ "$(idf slot_req_base 4)" -gt "$(($(idf slot_req_base 3) + 100000))" ] && echo yes || echo no)" "yes"
  rm -rf "$(dirname "$id_snippet")"
fi

echo "== a converge failure in phase 1 refuses the rung, and phase 2 never starts"
# The barrier's whole point, EXECUTED rather than grepped: the real run_density_rung is run
# with converge_slot and grpc_exec_record stubbed, so the assertion is about the real
# control flow. A marker file records whether any Exec was issued at all.
bar_body="$(extract_fns die log require_numeric json_escape e11_tool_call_mix escaped_mix slot_run_id slot_workspace_key slot_req_base run_density_rung || true)"
check "run_density_rung is extractable together with its slot helpers" \
  "$([ -n "$bar_body" ] && echo yes || echo no)" "yes"

if [ -n "$bar_body" ]; then
  bar_tmpdir="$(mktemp -d)"
  bar_probe="$bar_tmpdir/probe.sh"
  mkdir -p "$bar_tmpdir/results" "$bar_tmpdir/tmp"
  {
    echo 'set -uo pipefail'
    printf '%s\n' "$bar_body"
    # Stubs, defined AFTER the real functions so they win.
    echo 'assert_relay_alive() { :; }'
    echo 'converge_slot() { echo 5; return "$BAR_CONVERGE_RC"; }'
    echo 'grpc_exec_record() { : >"$BAR_MARKER"; echo "1 ok -" >>"$6"; }'
    echo 'host_sampler_loop() { :; }'
    echo 'percentile() { echo 1; }'
    echo 'run_density_rung "$@"'
  } >"$bar_probe"

  bar_env() {
    env BAR_CONVERGE_RC="$1" BAR_MARKER="$bar_tmpdir/exec-was-issued" \
      E11_TMPDIR="$bar_tmpdir/tmp" RESULTS="$bar_tmpdir/results" \
      ITERS_PER_SLOT=1 WARMUP_PER_SLOT=0 COLD_LATENCY_MS=50 \
      SUBSTRATE=nested-m8i REPO_CACHE_SHAPE=accept-cold-fetch \
      PROC_ROOT="$bar_tmpdir/proc" VMM_PROC_PATTERN=__none__ VIRTIOFSD_PROC_PATTERN=__none__ \
      SAMPLE_INTERVAL_MS=1000 SAMPLE_SLICE_MS=100 SAMPLE_MIN_TICK_MS=200 SAMPLE_LOW_EVERY=5 \
      EXEC_MAX_TIME_S=45 PROTO_IMPORT_PATH=/tmp PROTO_REL_PATH=x.proto \
      EXEC_CLIENT=grpcurl \
      bash "$bar_probe" container - - 2 e11-test 8444 "$bar_tmpdir/out.json"
  }

  rm -f "$bar_tmpdir/exec-was-issued"
  bar_fail_rc=0
  bar_fail_out="$(bar_env 1 2>&1)" || bar_fail_rc=$?
  check "a converge failure in phase 1 makes the rung exit NONZERO" \
    "$([ "$bar_fail_rc" -ne 0 ] && echo yes || echo no)" "yes"
  case "$bar_fail_out" in *"slot(s) fail before their timed loop"*) bar_named=yes ;; *) bar_named=no ;; esac
  check "  ...with the refusal that names the rung and the count" "$bar_named" "yes"
  check "  ...and NOT ONE Exec was issued: the barrier held" \
    "$([ -e "$bar_tmpdir/exec-was-issued" ] && echo issued || echo none)" "none"
  check "  ...and no rung record was written" \
    "$([ -s "$bar_tmpdir/out.json" ] && echo wrote || echo nothing)" "nothing"

  # NON-VACUOUSNESS: with converge SUCCEEDING, the same probe does reach phase 2. Without
  # this, "none" above could mean the probe never ran at all. Only the marker is asserted --
  # the probe is free to die later, in the record writer it has no real inputs for.
  rm -f "$bar_tmpdir/exec-was-issued" "$bar_tmpdir/out.json"
  bar_env 0 >/dev/null 2>&1 || true
  check "non-vacuousness: with converge succeeding, phase 2 DOES issue Execs" \
    "$([ -e "$bar_tmpdir/exec-was-issued" ] && echo issued || echo none)" "issued"

  rm -rf "$bar_tmpdir"
fi

echo "== a FAILED converge is not recorded as a fast converge"
# converge_slot used to discard grpcurl's status and return the timing anyway, so a converge
# that never prepared the workspace still produced a small convergeMsP50 -- wrong in the
# "looks cheap" direction -- and the slot's own Exec timings then measured something else.
check "converge_slot returns the RPC's own status" \
  "$([ "$(printf '%s\n' "$(extract_fn converge_slot)" | grep -c 'return "\$rc"')" -ge 1 ] && echo yes || echo no)" "yes"
check "a slot whose converge failed exits non-zero instead of continuing" \
  "$([ "$(grep -c 'converge FAILED after' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
# Two wait loops since the converge barrier landed (#291 item 3): one per phase, each
# checking every slot's status. A bare `wait` in either would discard the reason a slot
# failed.
check "the converge phase checks every slot's exit status, not a bare wait" \
  "$(grep -c 'wait "\$pid" || converge_failures=' "$SCRIPT")" "1"
check "the timed phase checks every slot's exit status too" \
  "$(grep -c 'wait "\$pid" || exec_failures=' "$SCRIPT")" "1"
check "  ...with the rung refused when any slot failed" \
  "$([ "$(grep -c 'slot(s) fail before their timed loop' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"

# ---------------------------------------------------------------------------
# A zero PSS total on the microvm arm is a refusal, not a reading (review 4001908599).
# ---------------------------------------------------------------------------
echo "== pssBytes: 0 is refused on the microvm arm, and still legitimate on the container arm"

vmm_body="$(extract_fns die require_numeric proc_meminfo_available mem_available_bytes discover_pids pss_bytes_for_pids host_cpu_fraction host_signals_snapshot || true)"
if [ -n "$vmm_body" ]; then
  vmm_tmpdir="$(mktemp -d)"
  vmm_snippet="$vmm_tmpdir/signals.sh"
  printf '%s\n' "$vmm_body" >"$vmm_snippet"
  vmm_proc="$vmm_tmpdir/proc"
  mkdir -p "$vmm_proc"
  printf 'MemTotal:  16384000 kB\nMemAvailable: 8192000 kB\n' >"$vmm_proc/meminfo"
  printf 'cpu  100 0 100 800 0 0 0 0 0 0\n' >"$vmm_proc/stat"

  snapshot_with() {
    (
      PROC_ROOT="$vmm_proc"
      export PROC_ROOT
      # shellcheck disable=SC2034 # read by host_signals_snapshot once sourced
      VMM_PROC_PATTERN="$1"
      # shellcheck disable=SC2034
      VIRTIOFSD_PROC_PATTERN="__e11_no_such_process__"
      # shellcheck disable=SC1090
      . "$vmm_snippet"
      host_signals_snapshot "$2"
    )
  }

  # --- NON-VACUOUSNESS: with require_vmm=0 the SAME no-match pattern succeeds and reports
  # pssBytes 0 -- which is correct on the container arm, and is exactly the value that used
  # to be accepted on the microvm arm too.
  cont_rc=0
  cont_json="$(snapshot_with "__e11_no_such_process__" 0 2>/dev/null)" || cont_rc=$?
  check "non-vacuousness: with require_vmm=0 a no-match pattern still succeeds" "$cont_rc" "0"
  check "  ...reporting pssBytes 0, which is correct for an arm with no VMM" \
    "$(printf '%s' "$cont_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["pssBytes"])' 2>&1)" "0"

  # --- The fix: the same sample with require_vmm=1 refuses, printing no JSON.
  vmm_rc=0
  vmm_out="$(snapshot_with "__e11_no_such_process__" 1 2>"$vmm_tmpdir/err")" || vmm_rc=$?
  check "with require_vmm=1, no matching VMM process is a REFUSAL (nonzero)" \
    "$([ "$vmm_rc" -ne 0 ] && echo yes || echo no)" "yes"
  check "  ...and it prints no JSON, so no rung can record pssBytes: 0" "$vmm_out" ""
  case "$(cat "$vmm_tmpdir/err")" in *"__e11_no_such_process__"*) vmm_named=yes ;; *) vmm_named=no ;; esac
  check "  ...and the refusal names the pattern that matched nothing" "$vmm_named" "yes"

  # --- And a matched process whose rollups sum to 0 is refused too: pids present is not
  # the same claim as memory measured.
  #
  # The pid set comes from the REAL discover_pids and the fabricated rollups cover ALL of
  # it, so this depends on no host process and on no shell's exec/fork choice -- see
  # spawn_marker_process for the ubuntu-24.04 failure that shape caused.
  vmm_marker="$(marker_token pss)"
  spawn_marker_process "$vmm_marker"
  vmm_marker_pid="$MARKER_PID"
  vmm_pids="$(discovered_pids_for "$vmm_snippet" "$vmm_marker" 1)"
  vmm_pid_count="$(count_pids "$vmm_pids")"
  # Non-vacuousness: everything below is about a NON-EMPTY matched pid set, so prove the
  # real discover_pids found one before asserting anything about what is done with it.
  check "non-vacuousness: the real discover_pids finds this block's marker process" \
    "$([ "$vmm_pid_count" -ge 1 ] && echo yes || echo no)" "yes"
  [ "$vmm_pid_count" -le 1 ] ||
    echo "  (note: the marker matched $vmm_pid_count processes; every one of them gets a fabricated rollup, so the totals below still add up)"

  plant_rollups "$vmm_proc" "$vmm_pids" 0
  zero_rc=0
  zero_out="$(snapshot_with "$vmm_marker" 1 2>/dev/null)" || zero_rc=$?
  check "a matched VMM whose PSS sums to 0 is refused as well" \
    "$([ "$zero_rc" -ne 0 ] && echo yes || echo no)" "yes"
  check "  ...printing no JSON" "$zero_out" ""

  # ...while a real, nonzero reading for the SAME pids is accepted, so the check above is
  # about the VALUE being zero and not about the pattern matching at all.
  plant_rollups "$vmm_proc" "$vmm_pids" 512
  nz_expected=$((512 * 1024 * vmm_pid_count))
  nz_rc=0
  nz_json="$(snapshot_with "$vmm_marker" 1 2>/dev/null)" || nz_rc=$?
  check "a nonzero PSS for the same matched pid IS accepted with require_vmm=1" "$nz_rc" "0"
  check "  ...and reports the real total" \
    "$(printf '%s' "$nz_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["pssBytes"])' 2>&1)" "$nz_expected"

  # --- And the CI failure mode itself, pinned as CORRECT behaviour rather than something to
  # be loosened away: a SECOND live process the pattern matches, whose rollup the fabricated
  # tree does not cover, makes the whole snapshot refuse. That is spec section 7.3's
  # never-guess-a-pid's-memory guarantee, and it is exactly what dash's forked `sleep`
  # child did to this block on ubuntu-24.04.
  spawn_marker_process "$vmm_marker"
  sibling_pid="$MARKER_PID"
  sib_pids="$(discovered_pids_for "$vmm_snippet" "$vmm_marker" $((vmm_pid_count + 1)))"
  if [ "$(count_pids "$sib_pids")" -le "$vmm_pid_count" ]; then
    echo "  (skip: the second marker process never became discoverable -- the uncovered-sibling refusal was not exercised, not claimed verified)"
  else
    sib_rc=0
    sib_out="$(snapshot_with "$vmm_marker" 1 2>/dev/null)" || sib_rc=$?
    check "an uncovered sibling pid makes the whole snapshot REFUSE (the ubuntu-24.04 symptom)" \
      "$([ "$sib_rc" -ne 0 ] && echo yes || echo no)" "yes"
    check "  ...printing no JSON, which is what left json.load with an empty file in CI" \
      "$sib_out" ""
  fi
  stop_marker_process "$sibling_pid"
  stop_marker_process "$vmm_marker_pid"

  rm -rf "$vmm_tmpdir"
fi

check "the in-rung microvm snapshot is the one that requires a VMM" \
  "$(grep -c 'host_signals_snapshot "\$require_vmm"' "$SCRIPT")" "1"
# The idle-residency poll must NOT require one: watching standbys be reclaimed to zero is
# spec section 7.4 prediction 5's predicted outcome, not a sampling failure.
check "the idle-residency poll deliberately does NOT require a VMM" \
  "$(grep -c 'host_signals_snapshot 0' "$SCRIPT")" "1"

# ---------------------------------------------------------------------------
# The EXIT trap (review 4001908613), exercised rather than grepped.
# ---------------------------------------------------------------------------
echo "== an EXIT trap tears the arm's stack down on every die/exit path"
check "a trap is installed at all (there were zero before)" \
  "$(grep -c '^trap cleanup_on_exit EXIT' "$SCRIPT")" "1"

trap_body="$(extract_fn cleanup_on_exit || true)"
check "cleanup_on_exit is extractable" "$([ -n "$trap_body" ] && echo yes || echo no)" "yes"

if [ -n "$trap_body" ]; then
  tr_tmpdir="$(mktemp -d)"
  tr_probe="$tr_tmpdir/probe.sh"
  tr_order="$tr_tmpdir/order"
  doomed="$tr_tmpdir/doomed"
  mkdir -p "$doomed/slots-container-d--ram--c1"
  : >"$doomed/slots-container-d--ram--c1/slot-1.times"
  {
    echo 'set -uo pipefail'
    echo 'stop_host_sampler() { echo sampler >>"$ORDER"; }'
    echo 'stop_container_stack() { echo container >>"$ORDER"; }'
    echo 'stop_microvm_stack() { echo microvm >>"$ORDER"; }'
    echo 'stop_null_stack() { echo null >>"$ORDER"; }'
    printf '%s\n' "$trap_body"
    echo 'trap cleanup_on_exit EXIT'
    echo 'exit 7'
  } >"$tr_probe"
  tr_rc=0
  ORDER="$tr_order" E11_TMPDIR="$doomed" bash "$tr_probe" || tr_rc=$?
  check "the trap does not swallow the script's exit status" "$tr_rc" "7"
  # The sampler goes FIRST: it is a background subshell that polls for its stop file, so
  # after `rm -rf $E11_TMPDIR` that file can never appear and it would spin forever writing
  # to a deleted path (#291 item 1).
  check "it kills the sampler and every arm's stack (kill before remove)" \
    "$(tr '\n' ' ' <"$tr_order")" "sampler container microvm null "
  check "and it removes the temp root, so no mktemp -d slot dir survives a die" \
    "$([ -e "$doomed" ] && echo survived || echo gone)" "gone"

  # Non-vacuousness for the removal: the same probe WITHOUT the trap leaves the dir behind,
  # so "gone" above is the trap's doing and not the shell's.
  mkdir -p "$doomed/slots-container-d--ram--c1"
  tr_probe2="$tr_tmpdir/probe-no-trap.sh"
  {
    echo 'set -uo pipefail'
    echo 'exit 7'
  } >"$tr_probe2"
  bash "$tr_probe2" || true
  check "non-vacuousness: without the trap the same dir survives the same exit" \
    "$([ -e "$doomed" ] && echo survived || echo gone)" "survived"

  rm -rf "$tr_tmpdir"
fi

check "every temp path lives under the trap-owned root, not a bare mktemp local" \
  "$(grep -v '^[[:space:]]*#' "$SCRIPT" | grep -cE 'mktemp( -d)? *$|mktemp( -d)?\)')" "0"
check "the temp root itself is created once, at script scope" \
  "$(grep -c '^E11_TMPDIR="\$(mktemp -d' "$SCRIPT")" "1"

# ---------------------------------------------------------------------------
# A read that fails AFTER `-r` passed: race vs refusal (issue #291 shakedown).
#
# /proc/<pid>/smaps_rollup passes a mode-bits `-r` test but its open is gated by ptrace
# permissions, and the pid can also exit in the window between the test and the read. Both were
# observed on real hardware, and unhandled BOTH silently contributed 0 kB to Sigma PSS -- awk's
# failure left pid_kb empty and bash arithmetic reads an empty string as 0. That is the
# RSS-fallback failure mode in disguise: the one number spec section 7.3 boxes as
# non-negotiable, under-reported in the optimistic direction, record still looking complete.
#
# awk is stubbed to fail rather than simulated into failing, so the branch is exercised
# deterministically on any platform.
# ---------------------------------------------------------------------------
echo "== a smaps read that fails after -r passed: alive REFUSES, exited is a silent race"

race_body="$(extract_fns die pss_bytes_for_pids || true)"
check "pss_bytes_for_pids is extractable for the race test" \
  "$([ -n "$race_body" ] && echo yes || echo no)" "yes"

if [ -n "$race_body" ]; then
  race_tmpdir="$(mktemp -d)"
  race_snippet="$race_tmpdir/race.sh"
  printf '%s\n' "$race_body" >"$race_snippet"
  race_proc="$race_tmpdir/proc"

  # --- ALIVE and unreadable: must refuse. A real live pid, so kill -0 succeeds.
  race_marker="$(marker_token race)"
  spawn_marker_process "$race_marker"
  race_live="$MARKER_PID"
  mkdir -p "$race_proc/$race_live"
  printf 'Pss:                 512 kB\n' >"$race_proc/$race_live/smaps_rollup"
  # NON-VACUOUSNESS: with awk working, this pid reads fine and contributes its 512 kB.
  race_ok=$(
    PROC_ROOT="$race_proc"
    # shellcheck disable=SC1090
    . "$race_snippet"
    pss_bytes_for_pids "$race_live"
  )
  check "non-vacuousness: with a working awk the live pid contributes its PSS" "$race_ok" "524288"
  race_rc=0
  race_out=$(
    (
      PROC_ROOT="$race_proc"
      # shellcheck disable=SC1090
      . "$race_snippet"
      # Stub AFTER sourcing so it shadows the real awk inside pss_bytes_for_pids.
      awk() { return 1; }
      pss_bytes_for_pids "$race_live"
    ) 2>&1
  ) || race_rc=$?
  check "a failed read on a LIVE pid refuses (nonzero), rather than contributing 0" \
    "$([ "$race_rc" -ne 0 ] && echo yes || echo no)" "yes"
  case "$race_out" in *"$race_live"*) race_named=yes ;; *) race_named=no ;; esac
  check "  ...and the refusal names the pid" "$race_named" "yes"
  case "$race_out" in *SH_E11_VMM_PROC_PATTERN*) race_hint=yes ;; *) race_hint=no ;; esac
  check "  ...and points at the unscoped pattern, the likeliest cause" "$race_hint" "yes"
  stop_marker_process "$race_live"

  # --- EXITED: a race. Contributes 0, exits clean, and prints NOTHING -- the noise that made a
  # benign race look like a defect (14 awk fatal lines in one three-arm smoke).
  race_dead=999999
  mkdir -p "$race_proc/$race_dead"
  printf 'Pss:                 512 kB\n' >"$race_proc/$race_dead/smaps_rollup"
  race_dead_rc=0
  race_dead_err=$(
    (
      PROC_ROOT="$race_proc"
      # shellcheck disable=SC1090
      . "$race_snippet"
      awk() { return 1; }
      pss_bytes_for_pids "$race_dead" >/dev/null
    ) 2>&1
  ) || race_dead_rc=$?
  check "a failed read on an EXITED pid is a race: exit 0, not a refusal" "$race_dead_rc" "0"
  check "  ...and it prints nothing at all (no awk fatal noise)" "$race_dead_err" ""
  race_dead_val=$(
    (
      PROC_ROOT="$race_proc"
      # shellcheck disable=SC1090
      . "$race_snippet"
      awk() { return 1; }
      pss_bytes_for_pids "$race_dead"
    ) 2>/dev/null
  )
  check "  ...and the exited pid contributes 0 bytes" "$race_dead_val" "0"

  rm -rf "$race_tmpdir"
fi

echo "== a thin rung warns at run time instead of passing unremarked"
# hostCpuSamples is recorded, but it is one field in a 30-field record and a 1-2 sample mean
# cannot support a saturation verdict. Both arms measured at 75-256 Exec/sec on the nested rig
# produced exactly one sample at the shipped ITERS_PER_SLOT, so this is the common case, not the
# corner case. It must WARN, not refuse -- a thin rung is legitimate.
thin_rdr="$(extract_fn run_density_rung || true)"
if [ -n "$thin_rdr" ]; then
  check "run_density_rung warns when a rung is built from very few host samples" \
    "$([ "$(printf '%s\n' "$thin_rdr" | grep -c 'produced only \$cpu_samples host sample')" -ge 1 ] && echo yes || echo no)" "yes"
  check "  ...as a log, NOT a die (a thin rung is legitimate)" \
    "$(printf '%s\n' "$thin_rdr" | grep 'produced only \$cpu_samples host sample' | grep -c '^ *log ')" "1"
  check "  ...and it names both knobs an operator would reach for" \
    "$([ "$(printf '%s\n' "$thin_rdr" | grep 'produced only' | grep -c 'SH_E11_ITERS_PER_SLOT.*SH_E11_SAMPLE_INTERVAL_MS')" -ge 1 ] && echo yes || echo no)" "yes"
  thin_warn_line="$(printf '%s\n' "$thin_rdr" | grep -n 'cpu_samples" -lt 5' | head -n1 | cut -d: -f1)"
  thin_mean_line="$(printf '%s\n' "$thin_rdr" | grep -n 'require_numeric hostCpuFraction' | head -n1 | cut -d: -f1)"
  check "the warning is evaluated after the sample count is known" \
    "$([ -n "$thin_warn_line" ] && [ -n "$thin_mean_line" ] && [ "$thin_warn_line" -lt "$thin_mean_line" ] && echo yes || echo no)" "yes"
fi
check "the ITERS_PER_SLOT default carries the >=10-ticks sizing rule" \
  "$([ "$(grep -c 'AT LEAST ~10 SAMPLER TICKS' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"

# ---------------------------------------------------------------------------
# A ladder may only contain rungs from THIS run (issue #291 shakedown).
#
# $RESULTS accumulates across runs and nothing clears it. assemble_ladder globbed
# e11-rung-<arm>-c*.json, so a rung from an earlier run with different settings joined the current
# ladder silently -- observed for real: a c=2 rung from a 20-iter smoke reappeared inside a
# 600-iter ladder carrying its one-sample hostCpuFraction. detectKnee anchors on the c=1 baseline,
# so a stale c=1 re-scales every health decision after it.
# ---------------------------------------------------------------------------
echo "== assemble_ladder takes only this run's rungs, and says what it dropped"

al_body="$(extract_fns die assemble_ladder || true)"
# Guarded on assemble_ladder ALONE, not on the concatenation: extract_fns prints each body as it
# iterates and only fails at the first MISSING name, so `die` alone would make the concatenation
# non-empty and this guard would pass while the snippet lacked the function under test. That
# happened while writing this very block -- the sourced snippet had only `die` and every call
# below exited 127.
check "assemble_ladder alone is extractable (a guard extract_fns cannot fake)" \
  "$([ -n "$(extract_fn assemble_ladder || true)" ] && echo yes || echo no)" "yes"

if [ -n "$al_body" ]; then
  al_tmpdir="$(mktemp -d)"
  al_snippet="$al_tmpdir/al.sh"
  printf '%s\n' "$al_body" >"$al_snippet"
  mk_rung() { printf '{"c": %s, "runId": %s, "throughput": 1.0}\n' "$1" "$2" >"$al_tmpdir/e11-rung-x-c$1.json"; }
  # Two rungs from this run, one left over from an earlier one.
  mk_rung 1 '"RUN-CURRENT"'
  mk_rung 4 '"RUN-CURRENT"'
  mk_rung 2 '"RUN-STALE"'
  al_out="$al_tmpdir/ladder.json"
  al_rc=0
  al_err=$(
    (
      E11_RUN_ID="RUN-CURRENT"
      # shellcheck disable=SC1090
      . "$al_snippet"
      assemble_ladder "$al_tmpdir/e11-rung-x-c*.json" "$al_out"
    ) 2>&1
  ) || al_rc=$?
  check "it succeeds when at least one rung is from this run" "$al_rc" "0"
  check "  ...and the ladder contains ONLY this run's rungs" \
    "$(python3 -c 'import json,sys; print(",".join(str(r["c"]) for r in json.load(open(sys.argv[1]))))' "$al_out")" "1,4"
  case "$al_err" in *SKIPPED*e11-rung-x-c2.json*) al_said=yes ;; *) al_said=no ;; esac
  check "  ...and it NAMES the stale record it dropped, rather than dropping it silently" "$al_said" "yes"

  # NON-VACUOUSNESS: without the runId filter a glob would have taken all three.
  check "non-vacuousness: the glob really does match all three files" \
    "$(ls "$al_tmpdir"/e11-rung-x-c*.json | wc -l | tr -d ' ')" "3"

  # An all-stale directory is a refusal, not an empty ladder.
  al_stale_rc=0
  al_stale_err=$(
    (
      E11_RUN_ID="RUN-DIFFERENT"
      # shellcheck disable=SC1090
      . "$al_snippet"
      assemble_ladder "$al_tmpdir/e11-rung-x-c*.json" "$al_tmpdir/ladder2.json"
    ) 2>&1
  ) || al_stale_rc=$?
  check "an all-stale directory REFUSES rather than writing an empty ladder" \
    "$([ "$al_stale_rc" -ne 0 ] && echo yes || echo no)" "yes"
  check "  ...and writes no ladder file at all" \
    "$([ -e "$al_tmpdir/ladder2.json" ] && echo wrote || echo nothing)" "nothing"
  case "$al_stale_err" in *"mixing runs is worse than no ladder"*) al_why=yes ;; *) al_why=no ;; esac
  check "  ...and the refusal explains why a mixed ladder is worse than none" "$al_why" "yes"

  # A record predating the stamp has no runId and must count as stale (the safe direction).
  printf '{"c": 8, "throughput": 1.0}\n' >"$al_tmpdir/e11-rung-x-c8.json"
  al_nostamp=$(
    (
      # shellcheck disable=SC2034 # read by assemble_ladder once sourced below; this is the
      # LEXICALLY LAST E11_RUN_ID assignment, which is where shellcheck reports the file-wide finding
      E11_RUN_ID="RUN-CURRENT"
      # shellcheck disable=SC1090
      . "$al_snippet"
      assemble_ladder "$al_tmpdir/e11-rung-x-c*.json" "$al_tmpdir/ladder3.json"
    ) 2>&1 >/dev/null
  )
  check "a record with NO runId is treated as stale (it cannot be shown to be ours)" \
    "$(python3 -c 'import json,sys; print(",".join(str(r["c"]) for r in json.load(open(sys.argv[1]))))' "$al_tmpdir/ladder3.json")" "1,4"
  case "$al_nostamp" in *e11-rung-x-c8.json*) al_named8=yes ;; *) al_named8=no ;; esac
  check "  ...and it is named among the skipped" "$al_named8" "yes"

  rm -rf "$al_tmpdir"
fi
check "every rung record carries the run id" \
  "$(grep -c "'runId': '\$E11_RUN_ID'," "$SCRIPT")" "1"

echo "== RSS is never read as a fallback anywhere pss_bytes_for_pids or its callers run"
# Comment lines (the header's own disclosure that RSS/VmRSS is deliberately
# avoided) are stripped first, so this targets actual code, not prose that
# mentions the forbidden pattern by name while explaining its absence.
code_only="$(grep -v '^[[:space:]]*#' "$SCRIPT")"
check "no VmRSS field is ever read in code (comments excluded)" \
  "$(printf '%s\n' "$code_only" | grep -c 'VmRSS')" "0"
check "no /proc/<pid>/status is ever read in code for memory accounting (comments excluded)" \
  "$(printf '%s\n' "$code_only" | grep -c '/status')" "0"
check "the header explicitly documents that VmRSS/status is never used as a fallback" \
  "$([ "$(grep -c 'NEVER reads VmRSS' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "smaps_rollup is the only source cited for PSS" \
  "$([ "$(grep -c 'smaps_rollup' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"

# ---------------------------------------------------------------------------
# 2. "the ladder includes c=1"
# ---------------------------------------------------------------------------
echo "== the active-runs ladder includes c=1"
check "ACTIVE_RUNS default includes 1" \
  "$(grep -c 'SH_E11_ACTIVE_RUNS:-1 ' "$SCRIPT")" "1"
check "the header explains why (detectKnee's c===1 baseline requirement)" \
  "$([ "$(grep -c 'c === 1\|c===1\|c=1' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"

# ---------------------------------------------------------------------------
# 3. "converge is timed separately"
# ---------------------------------------------------------------------------
echo "== converge is timed as its own Exec, before the steady-state loop, in its own field"
check "build_converge_script exists (harness/src/converge.ts's script, reproduced)" \
  "$(grep -c '^build_converge_script() {' "$SCRIPT")" "1"
check "converge_slot times it host-side, separately" \
  "$(grep -c '^converge_slot() {' "$SCRIPT")" "1"
# Matched on the JSON KEY, not on every mention of the name: the refusals that keep a
# converge timing from being fabricated name the field in their messages too, and counting
# mentions made this assertion go red on code that got stricter.
check "converge result lands in its own JSON field (convergeMsP50), not p95Ms" \
  "$(grep -c "'convergeMsP50':" "$SCRIPT")" "1"
check "  ...and p95Ms is a separate key, not the same one" \
  "$(grep -c "'p95Ms':" "$SCRIPT")" "1"
# Structural: converge_slot must be invoked BEFORE the Exec-mix while-loop within
# run_density_rung, not after -- extract the function and check line order.
rdr_body="$(extract_fn run_density_rung || true)"
check "run_density_rung exists" "$([ -n "$rdr_body" ] && echo yes || echo no)" "yes"
if [ -n "$rdr_body" ]; then
  converge_line=$(printf '%s\n' "$rdr_body" | grep -n 'converge_slot' | head -n1 | cut -d: -f1)
  mix_line=$(printf '%s\n' "$rdr_body" | grep -n 'e11_tool_call_mix\|while \[' | head -n1 | cut -d: -f1)
  check "converge_slot is called before the Exec-mix loop starts" \
    "$([ -n "$converge_line" ] && [ -n "$mix_line" ] && [ "$converge_line" -lt "$mix_line" ] && echo yes || echo no)" "yes"
fi

echo "== build_converge_script matches harness/src/converge.ts's buildConvergeScript shape"
conv_body="$(extract_fn build_converge_script || true)"
check "reproduces the flock-serialized fetch" "$(printf '%s' "$conv_body" | grep -c 'flock 9')" "1"
check "reproduces the /workspace/repo path" "$(printf '%s' "$conv_body" | grep -c '/workspace/repo')" "1"
check "reproduces the /workspace/leaves/<runId> leaf path" "$(printf '%s' "$conv_body" | grep -c '/workspace/leaves')" "2"
check "reproduces the retry-with-fresh-init-on-fetch-failure branch" \
  "$([ "$(printf '%s' "$conv_body" | grep -c 'git init -q')" -ge 2 ] && echo yes || echo no)" "yes"
check "reproduces worktree add --detach" "$(printf '%s' "$conv_body" | grep -c 'worktree add')" "1"

# ---------------------------------------------------------------------------
# 4. "section 4.5's shape is recorded"
# ---------------------------------------------------------------------------
echo "== section 4.5's repo-cache shape is recorded, and only the three named shapes validate"
check "repoCacheShape lands in the JSON record" "$(grep -c 'repoCacheShape' "$SCRIPT")" "1"
val_body="$(extract_fn validate_repo_cache_shape || true)"
check "validate_repo_cache_shape helper exists" "$([ -n "$val_body" ] && echo yes || echo no)" "yes"

if [ -n "$val_body" ]; then
  val_tmpdir="$(mktemp -d)"
  val_snippet="$val_tmpdir/val.sh"
  {
    echo 'die() { echo "e11: $*" >&2; exit 1; }'
    printf '%s\n' "$val_body"
  } >"$val_snippet"
  run_validate() {
    (
      REPO_CACHE_SHAPE="$1"
      export REPO_CACHE_SHAPE
      # shellcheck disable=SC1090
      . "$val_snippet"
      validate_repo_cache_shape
    )
  }
  for shape in two-mounts shared-clone accept-cold-fetch; do
    rc_shape=0
    run_validate "$shape" >/dev/null 2>&1 || rc_shape=$?
    check "shape '$shape' (one of section 4.5's three) validates" "$rc_shape" "0"
  done
  rc_bad=0
  bad_out=$(run_validate "made-up-shape" 2>&1) || rc_bad=$?
  check "an invented fourth shape is refused (nonzero)" "$([ "$rc_bad" -ne 0 ] && echo yes || echo no)" "yes"
  case "$bad_out" in *"made-up-shape"*) named_bad=yes ;; *) named_bad=no ;; esac
  check "the refusal names the bad value" "$named_bad" "yes"
  rm -rf "$val_tmpdir"
fi

check "this task DOES NOT decide among the three shapes (F7): no shape is hardcoded as the only option" \
  "$([ "$(grep -c 'REPO_CACHE_SHAPE=\"\${SH_E11_REPO_CACHE_SHAPE' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"

# ---------------------------------------------------------------------------
# 5. "the four idle settings are recorded and not swept"
# ---------------------------------------------------------------------------
echo "== the four section 4.1 settings are recorded, and no env var sweeps them"
static_body="$(extract_fn static_settings_json || true)"
check "static_settings_json helper exists" "$([ -n "$static_body" ] && echo yes || echo no)" "yes"
if [ -n "$static_body" ]; then
  static_out=$(
    # shellcheck disable=SC1090
    . <(printf '%s\n' "$static_body")
    static_settings_json
  )
  check "records standbyIdleS=90 (DefaultStandbyIdle)" \
    "$(printf '%s' "$static_out" | grep -c '"standbyIdleS":90')" "1"
  check "records workspaceIdleS=1800 (DefaultWorkspaceIdle, 30m)" \
    "$(printf '%s' "$static_out" | grep -c '"workspaceIdleS":1800')" "1"
  check "records replenishDelayS=0.2 (DefaultReplenishDelay, 200ms)" \
    "$(printf '%s' "$static_out" | grep -c '"replenishDelayS":0.2')" "1"
  check "records reclaimScanIntervalS=22.5 (StandbyIdle/4)" \
    "$(printf '%s' "$static_out" | grep -c '"reclaimScanIntervalS":22.5')" "1"
fi
for var in SH_E11_STANDBY_IDLE SH_E11_WORKSPACE_IDLE SH_E11_REPLENISH_DELAY SH_E11_RECLAIM_SCAN_INTERVAL; do
  check "no sweep env var exists for $var (there is nothing to override)" \
    "$(grep -c "$var" "$SCRIPT")" "0"
done
check "staticSettings is embedded in every rung's JSON record" \
  "$(grep -c 'staticSettings' "$SCRIPT")" "1"

# ---------------------------------------------------------------------------
# 6. "the driver is open-loop or declares the bias"
# ---------------------------------------------------------------------------
echo "== the closed-loop bias is declared, not silently eliminated or hidden"
check "drivingModel is recorded in the JSON output" "$(grep -c 'drivingModel' "$SCRIPT")" "3"
check "the recorded value names the model" "$(grep -c 'closed-loop-per-slot' "$SCRIPT")" "2"
check "drivingModel's JSON-output occurrence is the exact declared value" \
  "$([ "$(grep -c "'drivingModel': 'closed-loop-per-slot'" "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "the header comment explains WHY this is a declared bias, not a fix" \
  "$([ "$(grep -c 'coordinated omission' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"

# ---------------------------------------------------------------------------
# 7. "both arms are driven by the same code path"
# ---------------------------------------------------------------------------
echo "== the container and microvm arms are driven by ONE function, not two"
check "run_density_rung is defined exactly once" \
  "$(grep -c '^run_density_rung() {' "$SCRIPT")" "1"
# Comments stripped: dimension_literal's own comment quotes the container call site
# verbatim (it is where the "-" dashes come from), and counting prose broke this check.
check "main() calls run_density_rung for the container arm" \
  "$(grep -v '^[[:space:]]*#' "$SCRIPT" | grep -c 'run_density_rung container')" "1"
check "main() calls run_density_rung for the microvm arm" \
  "$(grep -v '^[[:space:]]*#' "$SCRIPT" | grep -c 'run_density_rung microvm')" "1"
check "no second, arm-specific Exec-driving function exists" \
  "$(grep -Ec '^run_density_rung_(container|microvm)\(\)' "$SCRIPT")" "0"
check "grpc_exec_record (the actual RPC call) is defined exactly once, used by both arms" \
  "$(grep -c '^grpc_exec_record() {' "$SCRIPT")" "1"

# ---------------------------------------------------------------------------
# Additional structural properties this task's hardware-corrections require,
# beyond the brief's own seven-item checklist.
# ---------------------------------------------------------------------------
echo "== F5: Cloud Hypervisor is absent as an arm, and the reason is stated"
check "no cloud-hypervisor arm is driven" "$(grep -c 'cloud-hypervisor' "$SCRIPT")" "0"
check "the header explains CH's absence is because it does not restore" \
  "$([ "$(grep -c 'does not restore' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "the exact CH hang signature is cited (Restoring virtio-console __console)" \
  "$(grep -c 'Restoring virtio-console __console' "$SCRIPT")" "1"

echo "== the microvm arm passes SH_VMM=firecracker explicitly (never a host-exec fallback)"
check "SH_VMM=firecracker is set when starting the microvm worker" \
  "$(grep -c 'SH_VMM=firecracker' "$SCRIPT")" "1"

echo "== virtiofsd's legitimate absence on the Firecracker-only arm is documented"
# Three since the in-rung sampler landed (#291 item 1): the config binding, the post-load
# snapshot, and the sampler's low-cadence tick.
check "virtiofsd is still sampled for (summed, can legitimately be 0)" \
  "$(grep -c 'VIRTIOFSD_PROC_PATTERN' "$SCRIPT")" "3"
check "the header states 0 virtiofsd PSS here is expected, not a bug" \
  "$([ "$(grep -c 'EXPECTED result of an absent process' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"

echo "== F3: SH_SUBSTRATE is a required, explicit label (never auto-derived, never metal-defaulted)"
check "SUBSTRATE binding uses SH_SUBSTRATE:? (required, not defaulted)" \
  "$(grep -c 'SH_SUBSTRATE:?' "$SCRIPT")" "1"
# The header legitimately WARNS against SH_SUBSTRATE=metal in a comment (F3
# disclosure); that mention must not be confused with an actual assignment.
# Strip comment lines first so this targets code, not the warning itself.
check "no hardcoded SH_SUBSTRATE=metal assignment appears in code (comments excluded)" \
  "$(grep -v '^[[:space:]]*#' "$SCRIPT" | grep -c 'SH_SUBSTRATE=metal')" "0"
check "the header explicitly warns against SH_SUBSTRATE=metal on this box" \
  "$([ "$(grep -c 'never pass SH_SUBSTRATE=metal' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"

echo "== leaseSaturations is always 0, and this is disclosed, not silently assumed"
check "leaseSaturations is hardcoded to 0 in the JSON record" \
  "$(grep -c "'leaseSaturations': 0," "$SCRIPT")" "1"
check "the limitation is disclosed in the recorded proxyLimitations" \
  "$(grep -c 'bypasses the harness lease layer' "$SCRIPT")" "1"

echo "== page-cache asymmetry: caches are dropped between arms, arm order is randomized"
check "drop_caches is present" "$(grep -c '^drop_caches() {' "$SCRIPT")" "1"
check "shuffle_e11_arms randomizes arm order" "$(grep -c '^shuffle_e11_arms() {' "$SCRIPT")" "1"

echo "== no guest-side timing: no 'date' embedded inside a guest command string"
bad_guest_date=$(grep -E -- '(command|script)[^#]*\bdate\b' "$SCRIPT" | grep -v 'date +%s%N' || true)
check "no 'date' embedded in a guest command/script string" "$([ -z "$bad_guest_date" ] && echo yes || echo no)" "yes"
check "the script itself times things host-side (date +%s%N used)" \
  "$([ "$(grep -c 'date +%s%N' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"

echo "== this script is never invoked by main(): it documents that it must be run by a human operator"
check "the header states it is not invoked by any automated test" \
  "$([ "$(grep -c 'NOT invoked by any automated test' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "source-only guard exists (E11_DENSITY_SOURCE_ONLY), matching e10's own pattern" \
  "$(grep -c 'E11_DENSITY_SOURCE_ONLY' "$SCRIPT")" "1"

echo "== security: the scratch redis is published on loopback, never on all interfaces"
# unbound_publishes prints every `docker run -p <host>:6379` publish in $1 whose host side
# is not explicitly bound to 127.0.0.1. `-p "6381:6379"` binds 0.0.0.0, which on the
# documented rig (an EC2 m8i.xlarge with a public interface, running microvm-worker as
# root) publishes an unauthenticated redis to the internet -- a standard host-takeover
# path via CONFIG SET dir + dbfilename.
unbound_publishes() {
  # Comment lines are stripped first (the same convention this file's VmRSS checks use):
  # the fix's own comments quote the pre-fix `-p "${PORT}:6379"` line by name, and a
  # whole-file grep would flag the explanation of the defect as the defect.
  grep -v '^[[:space:]]*#' "$1" | grep -nE -- '-p +"?[^ "]+:6379' | grep -v '127\.0\.0\.1' || true
}

# Non-vacuousness FIRST: the detector must flag the exact pre-fix line. Without this, an
# empty result below could mean "no publish is unbound" or "the regex matches nothing".
pub_fixture="$(mktemp)"
printf 'docker run --rm -d -p "${E11_REDIS_PORT}:6379" --name x redis:7 >/dev/null\n' >"$pub_fixture"
check "non-vacuousness: the detector DOES flag the pre-fix 0.0.0.0 publish" \
  "$([ -n "$(unbound_publishes "$pub_fixture")" ] && echo yes || echo no)" "yes"
rm -f "$pub_fixture"

check "no docker run publishes 6379 on all interfaces" \
  "$([ -z "$(unbound_publishes "$SCRIPT")" ] && echo yes || echo no)" "yes"
# The complement, so the check above cannot pass merely because the redis went away.
check "the redis publish is explicitly bound to 127.0.0.1" \
  "$([ "$(grep -c -- '-p "127.0.0.1:' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "both arms start redis through ONE helper (a second docker run cannot drift)" \
  "$(grep -v '^[[:space:]]*#' "$SCRIPT" | grep -c 'docker run')" "1"
check "start_redis_loopback is called by both arms" \
  "$(grep -c '^  start_redis_loopback ' "$SCRIPT")" "2"
check "the redis image is overridable so an operator can pin a digest" \
  "$(grep -c 'SH_E11_REDIS_IMAGE' "$SCRIPT")" "2"
check "redis is started with RDB snapshots disabled (--save '')" \
  "$([ "$(grep -c -- "--save ''" "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"

# ---------------------------------------------------------------------------
# Issue #291 section 4: the driver-overhead control arm.
#
# The whole reason this artifact survived a metal run is that there was no arm whose latency
# was known to be all driver. A third arm drives the IDENTICAL run_density_rung against
# remote-worker/cmd/null-responder -- one End per Exec, no relay, no Redis, no worker, no VMM
# -- so subtracting it at each c gives the driver's own contribution. If that share is large
# at high c, a fixed-but-still-grpcurl driver would show a knee that is STILL an artifact and
# item 3 of the issue becomes mandatory before the authoritative run.
#
# It is ON BY DEFAULT, opt-out. A control that has to be remembered is a control that will not
# be run.
# ---------------------------------------------------------------------------
echo "== the driver-control arm runs by default and is driven by the same function (#291 section 4)"
check "SH_E11_ARMS defaults to all three arms, control included" \
  "$([ "$(grep -c 'SH_E11_ARMS-container microvm driver-control' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "  ...via \${VAR-default}, not \${VAR:-default}: an explicit empty value must still refuse (issue #291 item 8)" \
  "$([ "$(grep -c 'SH_E11_ARMS:-container microvm driver-control' "$SCRIPT")" -eq 0 ] && echo yes || echo no)" "yes"
check "main() drives the control arm through run_density_rung, not a second function" \
  "$(grep -v '^[[:space:]]*#' "$SCRIPT" | grep -c 'run_density_rung driver-control')" "1"
check "no arm-specific Exec-driving function was added for it" \
  "$(grep -Ec '^run_density_rung_(container|microvm|driver_control|control)\(\)' "$SCRIPT")" "0"
check "the control arm's stack is ONLY the null-responder (no redis, no relay, no worker)" \
  "$(printf '%s\n' "$(extract_fn start_null_stack)" | grep -cE 'start_redis_loopback|sandbox-relay|cmd/worker|cmd/microvm-worker')" "0"
check "  ...and it builds the binary Task 5 added" \
  "$([ "$(printf '%s\n' "$(extract_fn start_null_stack)" | grep -c 'go build -o "\$E11_NULL_BIN" ./cmd/null-responder')" -ge 1 ] && echo yes || echo no)" "yes"
check "  ...on loopback only" \
  "$([ "$(printf '%s\n' "$(extract_fn start_null_stack)" | grep -c -- '-listen "127.0.0.1:')" -ge 1 ] && echo yes || echo no)" "yes"
check "  ...and waits for it to listen rather than sleeping and hoping" \
  "$([ "$(printf '%s\n' "$(extract_fn start_null_stack)" | grep -c 'wait_for_relay_port')" -ge 1 ] && echo yes || echo no)" "yes"
check "the control arm is torn down from the EXIT trap like the others" \
  "$([ "$(printf '%s\n' "$(extract_fn cleanup_on_exit)" | grep -c 'stop_null_stack')" -ge 1 ] && echo yes || echo no)" "yes"
check "analyze_slice is SKIPPED for the control arm (a ladder with no cold acquires)" \
  "$([ "$(grep -c 'analyze_slice skipped' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
check "  ...but its ladder is still assembled, because the subtraction needs it" \
  "$(grep -c 'e11-ladder-driver-control.json' "$SCRIPT")" "2"

echo "== SH_E11_ARMS unset defaults to all three arms; SH_E11_ARMS='' stays empty (issue #291 item 8)"
# \${VAR-default} (no colon) only substitutes when VAR is UNSET, unlike \${VAR:-default} which
# also substitutes when VAR is set-but-empty. Eval the real default-expansion line in isolation
# (not the whole script, which has unrelated top-level side effects) to prove the two cases
# actually differ, not just that the source text changed.
arms_default_line="$(grep -m1 'read -r -a E11_ARMS <<<"\${SH_E11_ARMS' "$SCRIPT")"
check "the E11_ARMS default-expansion line is found" \
  "$([ -n "$arms_default_line" ] && echo yes || echo no)" "yes"
if [ -n "$arms_default_line" ]; then
  arms_unset_out=$(
    (
      unset SH_E11_ARMS
      eval "$arms_default_line"
      printf '%s\n' "${E11_ARMS[*]}"
    )
  )
  check "  ...unset SH_E11_ARMS falls back to all three arms" \
    "$arms_unset_out" "container microvm driver-control"
  arms_empty_len=$(
    (
      # shellcheck disable=SC2034 # read by the eval'd default-expansion line below
      SH_E11_ARMS=""
      eval "$arms_default_line"
      echo "${#E11_ARMS[@]}"
    )
  )
  check "  ...SH_E11_ARMS='' (explicitly empty) is NOT defaulted -- stays zero arms" \
    "$arms_empty_len" "0"
fi

echo "== only the three named arms validate, and shuffling covers whatever is configured"
arms_body="$(extract_fns die validate_arms shuffle_e11_arms || true)"
check "validate_arms is extractable" "$([ -n "$arms_body" ] && echo yes || echo no)" "yes"
if [ -n "$arms_body" ]; then
  arms_tmpdir="$(mktemp -d)"
  arms_snippet="$arms_tmpdir/arms.sh"
  printf '%s\n' "$arms_body" >"$arms_snippet"
  run_arms() {
    (
      read -r -a E11_ARMS <<<"$1"
      # shellcheck disable=SC1090
      . "$arms_snippet"
      validate_arms
    )
  }
  for good in "container" "microvm" "driver-control" "container microvm driver-control" "microvm driver-control"; do
    arms_rc=0
    run_arms "$good" >/dev/null 2>&1 || arms_rc=$?
    check "SH_E11_ARMS='$good' validates" "$arms_rc" "0"
  done
  arms_bad_rc=0
  arms_bad_out="$(run_arms "container cloud-hypervisor" 2>&1)" || arms_bad_rc=$?
  check "an invented arm is refused (nonzero)" \
    "$([ "$arms_bad_rc" -ne 0 ] && echo yes || echo no)" "yes"
  case "$arms_bad_out" in *cloud-hypervisor*) arms_named=yes ;; *) arms_named=no ;; esac
  check "  ...and the refusal names the bad value" "$arms_named" "yes"
  arms_empty_rc=0
  run_arms "" >/dev/null 2>&1 || arms_empty_rc=$?
  check "an EMPTY arm list is refused: a sweep with no arms measures nothing" \
    "$([ "$arms_empty_rc" -ne 0 ] && echo yes || echo no)" "yes"

  shuf_out=$(
    (
      read -r -a E11_ARMS <<<"container microvm driver-control"
      # shellcheck disable=SC1090
      . "$arms_snippet"
      shuffle_e11_arms | sort | tr '\n' ' '
    )
  )
  check "shuffle_e11_arms emits exactly the configured arms, in some order" \
    "$shuf_out" "container driver-control microvm "
  shuf_two=$(
    (
      # shellcheck disable=SC2034 # read by shuffle_e11_arms once sourced below
      read -r -a E11_ARMS <<<"container driver-control"
      # shellcheck disable=SC1090
      . "$arms_snippet"
      shuffle_e11_arms | wc -l | tr -d ' '
    )
  )
  check "  ...and it does not hardcode two arms any more" "$shuf_two" "2"
  rm -rf "$arms_tmpdir"
fi

echo "== the control arm records a rung with null swept dimensions and no require_vmm trip"
# It follows the CONTAINER path: dimension_literal maps its "-" dimensions to None, and
# require_vmm stays 0 because that flag is gated on arm = microvm. Converge hits the responder
# too, which is correct -- the control measures the driver's cost for BOTH phases.
check "the control arm passes '-' for both swept dimensions, like the container arm" \
  "$([ "$(grep -c 'run_density_rung driver-control - -' "$SCRIPT")" -ge 1 ] && echo yes || echo no)" "yes"
rv_rdr="$(extract_fn run_density_rung || true)"
if [ -n "$rv_rdr" ]; then
  check "require_vmm is gated on the microvm arm alone, so the control arm cannot trip it" \
    "$(printf '%s\n' "$rv_rdr" | grep -c 'if \[ "\$arm" = "microvm" \] && \[ "\$d" != "0" \]')" "1"
  check "the idle standby-residency poll is likewise microvm-only" \
    "$(printf '%s\n' "$rv_rdr" | grep -c 'if \[ "\$arm" = "microvm" \]; then')" "1"
  check "the control arm has its own relay-log path for assert_relay_alive" \
    "$(printf '%s\n' "$rv_rdr" | grep -c 'e11-driver-control-responder.log')" "1"
fi

echo "== between-arm relay teardown kills by PORT, not just the captured PID"
# E11_RELAY_PID is $(pnpm ... start & echo $!) from inside a subshell -- on a host where
# pnpm stays running as a supervisor over a separate node child (rather than exec-ing into
# it), killing that PID kills pnpm and leaves the node child holding the port. The NEXT
# arm's relay then either dies with EADDRINUSE, or worse: a worker whose startup check only
# confirms something answers on the port -- never which relay -- silently attaches to the
# STALE relay left by the PREVIOUS arm. Both stop_*_stack functions must also kill by port.
check "kill_relay_by_port helper is defined" \
  "$(grep -c '^kill_relay_by_port() {' "$SCRIPT")" "1"
check "kill_relay_by_port finds its target via ss (by port), not pgrep -f (by name)" \
  "$(sed -n '/^kill_relay_by_port() {/,/^}/p' "$SCRIPT" | grep -c 'ss -ltnp')" "1"
check "kill_relay_by_port does not fall back to pgrep -f (by name)" \
  "$(sed -n '/^kill_relay_by_port() {/,/^}/p' "$SCRIPT" | grep -c 'pgrep -f')" "0"
check "stop_container_stack also kills by port (not only E11_RELAY_PID)" \
  "$(sed -n '/^stop_container_stack() {/,/^}/p' "$SCRIPT" | grep -c 'kill_relay_by_port')" "1"
check "stop_microvm_stack also kills by port (not only E11_RELAY_PID)" \
  "$(sed -n '/^stop_microvm_stack() {/,/^}/p' "$SCRIPT" | grep -c 'kill_relay_by_port')" "1"
check "kill_relay_by_port dies loudly rather than returning silently if the port never clears" \
  "$(sed -n '/^kill_relay_by_port() {/,/^}/p' "$SCRIPT" | grep -c 'die ')" "1"
check "kill_relay_by_port's cleanup-trap path logs and returns instead of dying" \
  "$(sed -n '/^kill_relay_by_port() {/,/^}/p' "$SCRIPT" | grep -c 'E11_IN_CLEANUP')" "1"
# ---------------------------------------------------------------------------
# SH_E11_EXEC_CLIENT: which client issues the timed Execs (issue #294)
# ---------------------------------------------------------------------------
echo "== the Exec client is selectable, defaults to grpcurl, and refuses anything else (#294)"

# The DEFAULT is the property that makes "opt-in" true rather than claimed: #294's own
# acceptance requires the bash path to stay the reference until the two are compared on one
# host, and a default of "go" would silently retire it.
check "SH_E11_EXEC_CLIENT defaults to grpcurl" \
  "$(grep -c 'EXEC_CLIENT="${SH_E11_EXEC_CLIENT:-grpcurl}"' "$SCRIPT")" "1"

vec_body="$(extract_fn validate_exec_client || true)"
check "validate_exec_client is extractable" "$([ -n "$vec_body" ] && echo yes || echo no)" "yes"

# Both accepted values, and a refusal for everything else. A typo would otherwise record a
# ladder under the wrong execClient and it would be compared against the wrong table.
for client in grpcurl go; do
  out="$(
    EXEC_CLIENT="$client"
    eval "$vec_body"
    die() {
      echo "DIED: $*"
      exit 1
    }
    validate_exec_client && echo ACCEPTED
  )"
  check "validate_exec_client accepts '$client'" "$out" "ACCEPTED"
done
# The invalid value must contain NEITHER accepted name. `grpcurl-go` did, and since die echoes
# the bad value back, the input itself satisfied a "does the message name both?" grep -- the
# check could not fail. Use a value that shares no substring with either answer.
out="$(
  # shellcheck disable=SC2034 # read by validate_exec_client, sourced via eval below
  EXEC_CLIENT="xyzzy"
  eval "$vec_body"
  die() {
    echo "DIED: $*"
    exit 1
  }
  validate_exec_client && echo ACCEPTED
)"
check "validate_exec_client refuses an unrecognised value" \
  "$(printf '%s' "$out" | grep -c '^DIED:')" "1"
# Each accepted value named SEPARATELY, matched on its quoted form as the message writes it, so
# neither assertion can be satisfied by the rejected input being echoed back.
check "  ...and its refusal names 'grpcurl' as an accepted value" \
  "$(printf '%s' "$out" | grep -c "'grpcurl'")" "1"
check "  ...and its refusal names 'go' as an accepted value" \
  "$(printf '%s' "$out" | grep -c "'go'")" "1"
# NON-VACUOUSNESS: the rejected value must NOT appear in quotes in a way that could satisfy
# either check above. Proven by feeding the detector a stripped-down message.
check "non-vacuousness: a refusal that only quotes the bad value fails the 'grpcurl' check" \
  "$(printf '%s' "DIED: SH_E11_EXEC_CLIENT is 'xyzzy', which is neither" | grep -c "'grpcurl'")" "0"

# preflight must validate it BEFORE any work: the build below depends on the value.
pf_body="$(extract_fn preflight || true)"
check "preflight validates the Exec client" \
  "$(printf '%s\n' "$pf_body" | grep -c 'validate_exec_client')" "1"

# build_exec_driver is a NO-OP on the reference path: a grpcurl run must not need a Go
# toolchain moment it never uses, and must not fail over ./cmd/exec-driver not compiling.
bed_body="$(extract_fn build_exec_driver || true)"
check "build_exec_driver is extractable" "$([ -n "$bed_body" ] && echo yes || echo no)" "yes"
check "build_exec_driver returns early unless the Go client was selected" \
  "$(printf '%s\n' "$bed_body" | grep -c '\[ "\$EXEC_CLIENT" = "go" \] || return 0')" "1"
check "build_exec_driver builds ./cmd/exec-driver" \
  "$(printf '%s\n' "$bed_body" | grep -c 'go build -o "\$E11_EXEC_DRIVER_BIN" ./cmd/exec-driver')" "1"
check "build_exec_driver dies with a reason when the build fails" \
  "$(printf '%s\n' "$bed_body" | grep -c 'die "go build ./cmd/exec-driver failed')" "1"
# Position, not presence. `grep -c build_exec_driver` passed with the two calls in either order,
# which made the check's own name false: what matters is that preflight -- which is what creates
# $RESULTS -- runs BEFORE the build writes a binary into it.
main_body="$(extract_fn main)"
check "main is extractable" "$([ -n "$main_body" ] && echo yes || echo no)" "yes"
mb_pf_line="$(printf '%s\n' "$main_body" | grep -n '^  preflight$' | head -n1 | cut -d: -f1)"
mb_bed_line="$(printf '%s\n' "$main_body" | grep -n '^  build_exec_driver$' | head -n1 | cut -d: -f1)"
check "main calls preflight" "$([ -n "$mb_pf_line" ] && echo yes || echo no)" "yes"
check "main calls build_exec_driver" "$([ -n "$mb_bed_line" ] && echo yes || echo no)" "yes"
check "  ...and build_exec_driver comes AFTER preflight, which creates \$RESULTS" \
  "$([ -n "$mb_pf_line" ] && [ -n "$mb_bed_line" ] && [ "$mb_pf_line" -lt "$mb_bed_line" ] && echo yes || echo no)" "yes"
# NON-VACUOUSNESS: the comparison must be able to say no. Same arithmetic, reversed operands.
check "non-vacuousness: the position comparison reports no when the order is reversed" \
  "$([ -n "$mb_pf_line" ] && [ -n "$mb_bed_line" ] && [ "$mb_bed_line" -lt "$mb_pf_line" ] && echo yes || echo no)" "no"

# The binary lives under $RESULTS, like the null-responder's, so a run leaves its artifacts
# in one place and preflight's own `mkdir -p "$RESULTS"` has already happened.
check "the exec-driver binary path is under \$RESULTS" \
  "$(grep -c 'E11_EXEC_DRIVER_BIN="\$RESULTS/.e11-exec-driver-bin"' "$SCRIPT")" "1"


# ---------------------------------------------------------------------------
# write_rung_plan: the bash-to-Go boundary (issue #294)
# ---------------------------------------------------------------------------
echo "== write_rung_plan emits a plan exec-driver can consume, with disjoint req_id spaces (#294)"

wrp_body="$(extract_fns write_rung_plan || true)"
check "write_rung_plan is extractable" "$([ -n "$wrp_body" ] && echo yes || echo no)" "yes"

plan_out="$(mktemp "${TMPDIR:-/tmp}/e11-plan.XXXXXX")"
# Two slots, bases from the REAL slot_req_base, and a mix containing the exact characters a
# hand-rolled bash JSON writer would corrupt: a double quote, a backslash, a pipe and a
# redirect. If these survive, escaping is genuinely json.dumps's job.
(
  eval "$(extract_fns slot_req_base write_rung_plan)"
  write_rung_plan "$plan_out" "localhost:8445" "e11-driver-control" \
    7 2 30 45 3 2 \
    'true' 'echo "a\b" > /tmp/x' 'grep -c e11 /tmp/x | wc -l' \
    "$(slot_req_base 1)" '' "/tmp/slots/slot-1.times" "/tmp/slots/slot-1.err" \
    "$(slot_req_base 2)" 'e11-microvm-d2-ram256-c2-slot2' "/tmp/slots/slot-2.times" "/tmp/slots/slot-2.err"
)
check "write_rung_plan wrote a non-empty plan" "$([ -s "$plan_out" ] && echo yes || echo no)" "yes"

plan_read() { python3 -c "import json,sys; print(json.load(open(sys.argv[1]))$1)" "$plan_out"; }
check "  target" "$(plan_read "['target']")" "localhost:8445"
check "  sandboxId" "$(plan_read "['sandboxId']")" "e11-driver-control"
check "  itersPerSlot" "$(plan_read "['itersPerSlot']")" "7"
check "  warmupPerSlot" "$(plan_read "['warmupPerSlot']")" "2"
check "  execTimeoutS" "$(plan_read "['execTimeoutS']")" "30"
check "  callDeadlineS" "$(plan_read "['callDeadlineS']")" "45"
check "  the whole mix is carried, in order" "$(plan_read "['mix'][0]")" "true"
check "  a mix command with a quote and a backslash survives verbatim" \
  "$(plan_read "['mix'][1]")" 'echo "a\b" > /tmp/x'
check "  a mix command with a pipe survives verbatim" \
  "$(plan_read "['mix'][2]")" 'grep -c e11 /tmp/x | wc -l'
check "  slot count" "$(plan_read "['slots'].__len__()")" "2"
# The req_id spaces come from the REAL slot_req_base, so this is the property that
# exec-driver's validateReqIDRanges enforces, asserted at the source.
check "  slot 1 reqBase is slot_req_base 1" "$(plan_read "['slots'][0]['reqBase']")" "1000000"
check "  slot 2 reqBase is slot_req_base 2" "$(plan_read "['slots'][1]['reqBase']")" "2000000"
check "  the container arm's empty workspace_key is preserved as empty" \
  "$(plan_read "['slots'][0]['workspaceKey']")" ""
check "  the microvm arm's workspace_key is carried" \
  "$(plan_read "['slots'][1]['workspaceKey']")" "e11-microvm-d2-ram256-c2-slot2"
check "  slot 1 timesFile" "$(plan_read "['slots'][0]['timesFile']")" "/tmp/slots/slot-1.times"
check "  slot 2 errFile" "$(plan_read "['slots'][1]['errFile']")" "/tmp/slots/slot-2.err"
rm -f "$plan_out"

# A partial mix would silently shrink what every slot loops over -- the same defect the
# existing escaped_mix count assertion guards on the grpcurl path.
plan_out2="$(mktemp "${TMPDIR:-/tmp}/e11-plan.XXXXXX")"
wrp_mismatch="$(
  eval "$(extract_fns write_rung_plan)"
  die() {
    echo "DIED"
    exit 1
  }
  write_rung_plan "$plan_out2" "localhost:8445" "sb" 7 2 30 45 3 1 \
    'true' 'false' \
    1000000 '' /tmp/a.times /tmp/a.err 2>/dev/null || echo REFUSED
)"
check "write_rung_plan refuses an argv that does not match its own counts" \
  "$(printf '%s' "$wrp_mismatch" | grep -cE 'DIED|REFUSED')" "1"
rm -f "$plan_out2"

# DRIFT GUARD: the plan's execTimeoutS must equal the timeout_s grpc_exec_record puts on the
# wire, or the two clients would be sending different Exec deadlines and their latencies would
# not be comparable. Both are read out of the real source text.
ger_timeout="$(extract_fn grpc_exec_record | grep -o '\\"timeout_s\\":[0-9]*' | head -n1 | cut -d: -f2)"
rdr_timeout="$(extract_fn run_density_rung | grep -A3 'write_rung_plan "\$plan_file"' | grep -oE '"\$ITERS_PER_SLOT" "\$WARMUP_PER_SLOT" [0-9]+' | grep -oE '[0-9]+$')"
check "the plan's execTimeoutS matches grpc_exec_record's timeout_s" "$rdr_timeout" "$ger_timeout"


# ---------------------------------------------------------------------------
# The phase-2 branch (issue #294)
# ---------------------------------------------------------------------------
echo "== phase 2 runs ONE exec-driver process on the Go path and c subshells on the grpcurl path (#294)"

rdr_body="$(extract_fn run_density_rung || true)"
check "run_density_rung is extractable" "$([ -n "$rdr_body" ] && echo yes || echo no)" "yes"

# The window body, extracted exactly as the fork guard above does it.
win="$(printf '%s\n' "$rdr_body" | awk '/wall_t0="/{f=1; next} /wall_t1="/{exit} f{print}' | grep -v '^[[:space:]]*#')"
check "the Go path runs the exec-driver binary inside the timed window" \
  "$(printf '%s\n' "$win" | grep -Fc '"$E11_EXEC_DRIVER_BIN" --plan "$plan_file"')" "1"
check "  ...exactly once, not once per slot" \
  "$(printf '%s\n' "$win" | grep -c 'for ((i = 1; i <= c; i++))')" "1"
check "  ...and the grpcurl subshell loop is still there, unchanged" \
  "$(printf '%s\n' "$win" | grep -Fc 'grpc_exec_record "$relay_port"')" "1"
check "  ...selected by EXEC_CLIENT, not by arm" \
  "$(printf '%s\n' "$win" | grep -Fc 'if [ "$EXEC_CLIENT" = "go" ]')" "1"
# write_rung_plan must NOT be in the window: Task 5 put it before wall_t0 and the fork guard
# above now flags python3, but assert the call site directly too, because that guard would also
# pass if the call vanished entirely.
check "write_rung_plan is called OUTSIDE the timed window" \
  "$(printf '%s\n' "$win" | grep -c 'write_rung_plan')" "0"
check "  ...and is called somewhere in run_density_rung" \
  "$(printf '%s\n' "$rdr_body" | grep -Fc 'write_rung_plan "$plan_file"')" "1"

# The refusal must not claim "1 of c slots" when one process drove all c of them.
check "the Go path's refusal says the whole rung is invalid, not one slot" \
  "$(printf '%s\n' "$rdr_body" | grep -c 'the Go exec-driver exited non-zero')" "1"
check "  ...and the grpcurl path keeps its per-slot refusal" \
  "$(printf '%s\n' "$rdr_body" | grep -c 'slot(s) fail inside the timed loop')" "1"

# Both paths still go through the SAME wait-and-refuse shape, which is what makes "a rung whose
# slots were not all measuring the same thing is never recorded" true for both.
check "both paths are waited on through the same pids array" \
  "$(printf '%s\n' "$rdr_body" | grep -Fc 'wait "$pid" || exec_failures=$((exec_failures + 1))')" "1"

# The ENQUEUE, not just the wait. The check above counts the shared wait loop, which stays at 1
# whether or not the Go branch ever adds its pid to the array -- so on its own it cannot catch
# the Go process being forked and then never waited on. That failure is silent and it corrupts
# the measurement: wall_t1 would be stamped without blocking on the driver, so the rung's wall
# time and throughput would describe a run that had not finished, and exec_failures would never
# see a Go-side failure.
# Scoped to the timed window on purpose: phase 1's converge loop has a third pids+= of its own,
# outside the window, so a whole-function count would be 3 and would not say what we mean.
check "both branches inside the timed window enqueue their pid" \
  "$(printf '%s\n' "$win" | grep -Fc 'pids+=("$!")')" "2"
# NON-VACUOUSNESS: the detector must be able to report a different number. Two literal
# fixtures -- one with both enqueues, one with a single enqueue -- run through the same
# grep -Fc prove it discriminates 2 from 1 rather than always reporting one fixed number.
check "non-vacuousness: the enqueue detector reports 2 for a two-enqueue fixture" \
  "$(printf 'pids+=("$!")\npids+=("$!")\n' | grep -Fc 'pids+=("$!")')" "2"
check "non-vacuousness: the enqueue detector reports 1 for a one-enqueue fixture" \
  "$(printf 'pids+=("$!")\n' | grep -Fc 'pids+=("$!")')" "1"

# Position, not just presence: two enqueues inside the window could both sit in one branch.
# This asserts the Go invocation is immediately followed by its own enqueue.
check "the Go branch's invocation is immediately followed by its own pids+=" \
  "$(printf '%s\n' "$win" | grep -A1 -F '"$E11_EXEC_DRIVER_BIN" --plan "$plan_file"' | grep -Fc 'pids+=("$!")')" "1"

# Converge stays on grpcurl on BOTH paths -- a stated non-goal. It is already outside the timed
# window and reported separately as convergeMsP50, so routing it through the new client would
# move a number this work is not measuring, inside the same PR that moves the one it is.
cs_body="$(extract_fn converge_slot || true)"
check "converge_slot is extractable" "$([ -n "$cs_body" ] && echo yes || echo no)" "yes"
check "converge still drives grpcurl, on every path" \
  "$(printf '%s\n' "$cs_body" | grep -c 'grpcurl -plaintext')" "1"
check "  ...and converge is not routed through EXEC_CLIENT at all" \
  "$(printf '%s\n' "$cs_body" | grep -c 'EXEC_CLIENT')" "0"
# ---------------------------------------------------------------------------
# SEAM CLOSURE (issue #294): the real plan writer -> the real binary -> the real responder.
#
# Everything above tests ONE side of the bash/Go boundary. This runs both. e11-density.sh
# itself cannot run here (it needs /proc, cgroups and Linux), so this is where the seam is
# actually verified, and it needs none of those things.
# ---------------------------------------------------------------------------
echo "== the real write_rung_plan drives the real exec-driver against the real null-responder (#294)"

if ! command -v go >/dev/null 2>&1; then
  echo "  SKIP: no go on PATH, so the exec-driver and null-responder cannot be built"
else
  seam_dir="$(mktemp -d "${TMPDIR:-/tmp}/e11-seam.XXXXXX")"
  seam_rc=0
  (
    cd "$DIR/../../remote-worker" &&
      go build -o "$seam_dir/exec-driver" ./cmd/exec-driver &&
      go build -o "$seam_dir/null-responder" ./cmd/null-responder
  ) >"$seam_dir/build.log" 2>&1 || seam_rc=$?
  check "both binaries build" "$seam_rc" "0"
  if [ "$seam_rc" -ne 0 ]; then
    # The driver-failure path below dumps its log; this one must too. $seam_dir is removed
    # unconditionally at the end of this section, so a compiler error not printed here is a
    # compiler error nobody will ever see -- and this is the only off-rig proof of the seam.
    echo "  go build said: $(cat "$seam_dir/build.log")"
  fi

  if [ "$seam_rc" -eq 0 ]; then
    # An ephemeral-ish port well away from the driver's defaults (8444/8445), so a stray relay
    # or responder from another run cannot answer this test's Execs.
    seam_port=18447
    "$seam_dir/null-responder" --listen "127.0.0.1:$seam_port" >"$seam_dir/responder.log" 2>&1 &
    seam_pid=$!
    # A CI timeout or SIGINT between here and the kill below would otherwise leave a gRPC
    # listener bound to this port for as long as the machine stays up. Split from a single
    # combined trap (review item 5): under bash a non-exiting INT/TERM handler returns
    # control to the script rather than terminating it, so a Ctrl-C or CI SIGTERM only reaped
    # the listener and let the suite continue -- and if the signal landed after the last seam
    # check, the suite printed "Total failures: 0" and exited 0 for a job someone cancelled.
    # The INT/TERM trap now reaps the listener AND re-exits with the conventional 128+signum
    # status for SIGINT (130), so cancellation is honored; EXIT keeps doing only cleanup. Both
    # are cleared after the normal teardown so neither can fire twice or mask a later signal.
    trap 'kill "$seam_pid" 2>/dev/null || true; exit 130' INT TERM
    trap 'kill "$seam_pid" 2>/dev/null || true' EXIT
    # Wait for the listener rather than sleeping a guessed interval.
    seam_up=no
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
      if grep -q 'serving sandbox.v1.SandboxExec' "$seam_dir/responder.log" 2>/dev/null; then
        seam_up=yes
        break
      fi
      sleep 0.25
    done
    check "the null-responder came up" "$seam_up" "yes"

    # THE REAL write_rung_plan, with slot identity from THE REAL slot_req_base and the mix from
    # THE REAL e11_tool_call_mix. Nothing here is a rewritten substitute.
    seam_plan="$seam_dir/plan.json"
    seam_iters=5
    seam_warmup=2
    seam_c=3
    (
      eval "$(extract_fns die slot_req_base e11_tool_call_mix write_rung_plan)"
      seam_argv=()
      while IFS= read -r seam_cmd; do seam_argv+=("$seam_cmd"); done < <(e11_tool_call_mix)
      seam_mix_count="${#seam_argv[@]}"
      for i in 1 2 3; do
        seam_argv+=("$(slot_req_base "$i")" "" "$seam_dir/slot-$i.times" "$seam_dir/slot-$i.err")
      done
      write_rung_plan "$seam_plan" "localhost:$seam_port" "e11-driver-control" \
        "$seam_iters" "$seam_warmup" 30 45 "$seam_mix_count" "$seam_c" "${seam_argv[@]}"
    ) >"$seam_dir/plan.log" 2>&1
    check "write_rung_plan produced a plan" "$([ -s "$seam_plan" ] && echo yes || echo no)" "yes"

    # THE REAL BINARY, reading THAT plan.
    drv_rc=0
    "$seam_dir/exec-driver" --plan "$seam_plan" >"$seam_dir/driver.log" 2>&1 || drv_rc=$?
    check "exec-driver accepted the real plan and exited 0" "$drv_rc" "0"
    if [ "$drv_rc" -ne 0 ]; then
      echo "  exec-driver said: $(cat "$seam_dir/driver.log")"
    fi

    # The times-file contract, end to end. iters+warmup lines per slot, all ok, all three fields.
    for i in 1 2 3; do
      check "slot $i wrote iters+warmup lines" \
        "$(wc -l <"$seam_dir/slot-$i.times" | tr -d ' ')" "$((seam_iters + seam_warmup))"
      # $1's shape is pinned to whole.fractional with exactly three decimal digits (review on
      # #294/#296): microseconds formatted as milliseconds to three decimal places, not the
      # bare integer the pre-fix truncation produced.
      check "  ...every line is '<ms> <status> <cause>' with status ok" \
        "$(awk 'NF==3 && $2=="ok" && $3=="-" && $1 ~ /^[0-9]+\.[0-9][0-9][0-9]$/ {n++} END{print n+0}' "$seam_dir/slot-$i.times")" \
        "$((seam_iters + seam_warmup))"
      check "  ...and its err file is empty, because nothing failed" \
        "$([ -s "$seam_dir/slot-$i.err" ] && echo nonempty || echo empty)" "empty"
    done

    # The aggregation run_density_rung performs on these files, reproduced here: the warmup is
    # trimmed off the FRONT and exactly ITERS lines remain. This is the property that makes
    # "nothing downstream changed" true rather than asserted.
    check "warmup trimming leaves exactly ITERS steady-state samples per slot" \
      "$(tail -n "+$((seam_warmup + 1))" "$seam_dir/slot-1.times" | head -n "$seam_iters" | wc -l | tr -d ' ')" \
      "$seam_iters"

    # And the req_ids the RESPONDER saw are disjoint and start one past each base. The
    # null-responder echoes the request's req_id in its End, so its own log is not a record of
    # them -- but the plan's bases plus the line counts pin the space, and exec-driver's own Go
    # test asserts the server-side view. What is asserted here is that the plan the REAL writer
    # produced carries the REAL slot_req_base spacing.
    check "the plan's slot bases are slot_req_base's, 1000000 apart" \
      "$(python3 -c 'import json,sys; s=json.load(open(sys.argv[1]))["slots"]; print(",".join(str(x["reqBase"]) for x in s))' "$seam_plan")" \
      "1000000,2000000,3000000"

    kill "$seam_pid" 2>/dev/null || true
    wait "$seam_pid" 2>/dev/null || true
    trap - INT TERM EXIT
  fi
  rm -rf "$seam_dir"
fi
echo
echo "Total failures: $fails"
exit "$fails"
