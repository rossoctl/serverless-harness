#!/usr/bin/env bash
# Cluster-free, root-free test for setup-vm.sh. Mocks podman/systemctl/getent onto PATH and
# asserts on the recorded argv, plus checks both unit files' ExecStart/WorkingDirectory
# pairing, their §4.3 hardening directives, the env-file contract each EnvironmentFile= line
# implies, and (last) a full main() run against the mocks.
set -euo pipefail

VM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$VM_DIR/setup-vm.sh"
UNIT_SUPERVISOR="$VM_DIR/systemd/sh-supervisor.service"
UNIT_RELAY="$VM_DIR/systemd/sh-relay.service"
ENV_SRC_DIR="$VM_DIR/env"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export MOCK_LOG="$TMP/mock.log"
mkdir -p "$TMP/bin"
for cmd in podman systemctl getent pnpm; do
  cat >"$TMP/bin/$cmd" <<'MOCK'
#!/usr/bin/env bash
printf '%s %s\n' "$(basename "$0")" "$*" >>"$MOCK_LOG"
MOCK
  chmod +x "$TMP/bin/$cmd"
done
# id needs real stdout (the caller parses `id -u`), not just a log line, so it gets its own
# mock rather than joining the log-only loop above. It reports uid 0 -- main() end to end
# below is standing in for a `sudo ./setup-vm.sh` invocation (B3).
cat >"$TMP/bin/id" <<'MOCK'
#!/usr/bin/env bash
printf '%s %s\n' "$(basename "$0")" "$*" >>"$MOCK_LOG"
if [[ "$*" == "-u" ]]; then
  echo 0
fi
MOCK
chmod +x "$TMP/bin/id"
export PATH="$TMP/bin:$PATH"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

export SH_SOURCE_ONLY=1
export SH_UNIT_DIR="$TMP/units" SH_ENV_DIR="$TMP/etc" SH_SANDBOX_COUNT=3
mkdir -p "$SH_UNIT_DIR"
# shellcheck source=/dev/null
source "$SCRIPT"

# --- sourcing must not touch the machine -------------------------------------------------
[[ ! -s "$MOCK_LOG" ]] || fail "sourcing ran commands: $(cat "$MOCK_LOG")"
pass "SH_SOURCE_ONLY sources without side effects"

# --- units land, and each carries the right ExecStart/WorkingDirectory and §4.3 hardening -
install_units
[[ -f "$SH_UNIT_DIR/sh-supervisor.service" ]] || fail "supervisor unit not installed"
[[ -f "$SH_UNIT_DIR/sh-relay.service" ]] || fail "relay unit not installed"
grep -q 'systemctl daemon-reload' "$MOCK_LOG" || fail "daemon-reload not invoked"

# unit -> package-dir pairs. WorkingDirectory must be the package's OWN dir (not the repo
# root) and ExecStart must match that package's own `start` script (`node --import tsx
# src/main.ts`) -- the same CWD-resolution fix already documented at
# deploy/knative/relay-deployment.yaml:20-32 and deploy/knative/control-plane.yaml:184-187:
# `node --import tsx` resolves the tsx loader relative to the CWD, and tsx is linked only
# into each package's own node_modules, never root-hoisted.
UNIT_PACKAGES=(
  "$UNIT_SUPERVISOR:supervisor"
  "$UNIT_RELAY:sandbox-relay"
)
for pair in "${UNIT_PACKAGES[@]}"; do
  unit="${pair%%:*}"
  pkg="${pair##*:}"
  grep -qE "^WorkingDirectory=/opt/serverless-harness/packages/$pkg\$" "$unit" ||
    fail "$unit: WorkingDirectory must be the $pkg package dir, not the repo root"
  grep -qE '^ExecStart=/usr/bin/node --import tsx src/main\.ts$' "$unit" ||
    fail "$unit: ExecStart must run src/main.ts relative to WorkingDirectory"
  for directive in ProtectSystem=strict NoNewPrivileges=true SystemCallFilter TimeoutStopSec \
    StateDirectory=serverless-harness; do
    # These are the VM analogue of the pod securityContext. Present, and asserted so a future
    # edit cannot quietly drop them -- §4.3 does not CLAIM parity, but it does claim presence.
    grep -q "$directive" "$unit" || fail "$unit is missing $directive"
  done
  # Nothing in deploy/vm/systemd/ installs a redis.service -- Redis runs as a bare podman
  # container from start_redis() in this same script -- so a Requires= here would name a unit
  # that can never resolve and the service would fail to start.
  if grep -q '^Requires=' "$unit"; then
    fail "$unit: Requires= names a unit nothing installs"
  fi
done
pass "both units: correct ExecStart/WorkingDirectory, §4.3 hardening present, no dangling Requires="

# --- every EnvironmentFile= has a shipped template (general form of the relay.env gap) -----
# Derive the env names from the units themselves, not by hard-coding "supervisor"/"relay" --
# that is what makes this catch the next env file somebody adds.
ENV_NAMES=()
for unit in "$UNIT_SUPERVISOR" "$UNIT_RELAY"; do
  # R46: under `set -euo pipefail`, a no-match `grep` in this pipeline aborts the script
  # right here -- before the `[[ -n "$name" ]] || fail ...` guard below can ever run. `|| true`
  # makes the guard reachable so a future unit missing EnvironmentFile= gets the diagnostic
  # instead of a raw abort.
  name=$( (grep -oE '^EnvironmentFile=/etc/serverless-harness/[A-Za-z0-9_.-]+\.env$' "$unit" ||
    true) | sed -E 's#.*/([A-Za-z0-9_.-]+)\.env$#\1#')
  [[ -n "$name" ]] || fail "$unit: no EnvironmentFile= line found"
  [[ -f "$ENV_SRC_DIR/$name.env.example" ]] ||
    fail "$unit references $name.env but deploy/vm/env/$name.env.example does not exist"
  ENV_NAMES+=("$name")
done
pass "every EnvironmentFile= has a shipped template"

# --- env files are written once and never clobbered ----------------------------------------
install_env
for name in "${ENV_NAMES[@]}"; do
  [[ -f "$SH_ENV_DIR/$name.env" ]] || fail "install_env did not install $name.env"
done
grep -q 'SH_TURNS_PER_WORKER=' "$SH_ENV_DIR/supervisor.env" || fail "env template incomplete"
grep -q 'SH_SANDBOX_DISCOVERY=records' "$SH_ENV_DIR/supervisor.env" ||
  fail "VM env must select records discovery (no cluster on a VM)"
echo 'SH_TURNS_PER_WORKER=9' >>"$SH_ENV_DIR/supervisor.env"
echo 'SH_RELAY_PORT=7777' >>"$SH_ENV_DIR/relay.env"
install_env
grep -q 'SH_TURNS_PER_WORKER=9' "$SH_ENV_DIR/supervisor.env" ||
  fail "install_env clobbered an operator-edited supervisor.env"
grep -q 'SH_RELAY_PORT=7777' "$SH_ENV_DIR/relay.env" ||
  fail "install_env clobbered an operator-edited relay.env"
pass "both env files written once, operator edits preserved"

# --- SH_TURNS_PER_WORKER ships EMPTY -------------------------------------------------------
# §3.8: shipping a value would put a guess where an E8 output belongs.
grep -qE '^SH_TURNS_PER_WORKER=$' "$ENV_SRC_DIR/supervisor.env.example" ||
  fail "the example env must leave SH_TURNS_PER_WORKER empty"
pass "no default shipped for SH_TURNS_PER_WORKER"

# --- the relay's bind port and the supervisor's dial port must agree (the real F3 bug) -----
# R46 (same as above): both assignments below can abort the pipeline on no-match under
# `set -euo pipefail`, before their `[[ -n ... ]] || fail ...` guards run -- `|| true` on the
# failure-capable stage in each, `grep -q` gating the second.
relay_port=$(grep -oE '^SH_RELAY_PORT=[0-9]+' "$ENV_SRC_DIR/relay.env.example" | cut -d= -f2 || true)
if grep -qE '^SH_RELAY_ADDR=.*:[0-9]+$' "$ENV_SRC_DIR/supervisor.env.example"; then
  addr_port=$(grep -oE '^SH_RELAY_ADDR=.*:[0-9]+$' "$ENV_SRC_DIR/supervisor.env.example" |
    grep -oE '[0-9]+$')
else
  addr_port=""
fi
[[ -n "$relay_port" ]] || fail "relay.env.example is missing SH_RELAY_PORT"
[[ -n "$addr_port" ]] || fail "supervisor.env.example's SH_RELAY_ADDR has no port"
[[ "$relay_port" == "$addr_port" ]] ||
  fail "SH_RELAY_PORT ($relay_port) in relay.env.example must equal the port in" \
    "SH_RELAY_ADDR ($addr_port) in supervisor.env.example -- they describe the same wire"
pass "relay bind port and supervisor dial port agree"

# --- SANDBOX_IMAGE default matches the rest of the repo (B1) --------------------------------
# deploy/knative/setup-ocp.sh:42 and setup-k8s.sh:30 both default to
# ghcr.io/rossoctl/serverless-harness-sandbox:latest -- the repo-name segment, not just the
# namespace, was dropped here. ghcr.io/rossoctl/sandbox:latest exists nowhere else in the repo.
[[ "$SANDBOX_IMAGE" == "ghcr.io/rossoctl/serverless-harness-sandbox:latest" ]] ||
  fail "SANDBOX_IMAGE default is '$SANDBOX_IMAGE', expected" \
    "ghcr.io/rossoctl/serverless-harness-sandbox:latest (matching setup-ocp.sh/setup-k8s.sh)"
pass "SANDBOX_IMAGE defaults to the image the rest of the repo actually publishes"

# --- sandbox count is honoured --------------------------------------------------------------
: >"$MOCK_LOG"
start_sandboxes
[[ "$(grep -c 'podman run .*sh-sandbox-' "$MOCK_LOG")" == "3" ]] ||
  fail "expected 3 sandbox containers, got: $(cat "$MOCK_LOG")"
pass "SH_SANDBOX_COUNT honoured"

# --- require_relay_token fails loudly on an unset token, passes once one is set (B5) --------
# relay.env.example ships SH_RELAY_TOKEN commented out (an operator secret, not a default),
# and the relay's validation is fail-closed (makeDefaultValidateToken in
# packages/sandbox-relay/src/main.ts) -- a fresh install would otherwise start sandbox
# containers that can never attach. require_relay_token takes an optional file override so this
# is testable without touching $SH_ENV_DIR/relay.env directly.
TOKENLESS_RELAY_ENV="$TMP/tokenless-relay.env"
cp "$ENV_SRC_DIR/relay.env.example" "$TOKENLESS_RELAY_ENV"
if token_err=$(require_relay_token "$TOKENLESS_RELAY_ENV" 2>&1); then
  fail "require_relay_token should fail when SH_RELAY_TOKEN is commented out"
fi
echo "$token_err" | grep -qi 'SH_RELAY_TOKEN' ||
  fail "require_relay_token's message must name SH_RELAY_TOKEN: $token_err"
pass "require_relay_token fails loudly on an unconfigured token"

TOKENED_RELAY_ENV="$TMP/tokened-relay.env"
cp "$ENV_SRC_DIR/relay.env.example" "$TOKENED_RELAY_ENV"
echo 'SH_RELAY_TOKEN=s3cr3t' >>"$TOKENED_RELAY_ENV"
require_relay_token "$TOKENED_RELAY_ENV" ||
  fail "require_relay_token should pass once SH_RELAY_TOKEN is set"
pass "require_relay_token passes once SH_RELAY_TOKEN is set"

# --- relay_token strips one matched pair of surrounding quotes (systemd's EnvironmentFile=
# semantics) ----------------------------------------------------------------------------------
# An operator writing SH_RELAY_TOKEN="s3cr3t" in relay.env gets s3cr3t handed to the relay
# process by systemd, not "s3cr3t" (systemd.exec(5), "Environment Variables in Spawned
# Processes") -- relay_token must return the same value systemd actually hands the relay, or
# start_sandboxes would pass every container a SANDBOX_TOKEN that never matches while
# require_relay_token's non-empty check still passes happily: the exact silently-empty
# sh:sandbox:records outcome B5 exists to prevent, reachable through an ordinary quoting habit.
QUOTED_RELAY_ENV="$TMP/quoted-relay.env"
cp "$ENV_SRC_DIR/relay.env.example" "$QUOTED_RELAY_ENV"
echo 'SH_RELAY_TOKEN="s3cr3t"' >>"$QUOTED_RELAY_ENV"
[[ "$(relay_token "$QUOTED_RELAY_ENV")" == "s3cr3t" ]] ||
  fail "relay_token must strip a matched pair of surrounding quotes (systemd.exec(5)" \
    "EnvironmentFile= semantics), got: [$(relay_token "$QUOTED_RELAY_ENV")]"
pass "relay_token strips a matched pair of surrounding quotes"

# --- start_sandboxes passes each container its own SANDBOX_ID, a host-reaching RELAY_ADDR, and
# the relay token, and pins host.containers.internal explicitly (B5) ------------------------
# The real bug: a bare `podman run` with no -e flags leaves every container at
# remote-worker/cmd/worker/main.go's defaults (SANDBOX_ID=sbx-laptop-1, RELAY_ADDR=
# localhost:8443, SANDBOX_TOKEN=dev-token) -- every container collides on one Redis record,
# "localhost" resolves to the container itself rather than the host, and the token never
# matches a fail-closed relay. --add-host pins host.containers.internal explicitly rather
# than relying on netavark's automatic (rootless-default, version-dependent) population of
# /etc/hosts -- see podman-run(1)'s host-gateway special string.
: >"$MOCK_LOG"
cp "$TOKENED_RELAY_ENV" "$SH_ENV_DIR/relay.env"
start_sandboxes
grep -q -- '-e SANDBOX_ID=sh-sandbox-0' "$MOCK_LOG" ||
  fail "start_sandboxes must set a per-container SANDBOX_ID: $(cat "$MOCK_LOG")"
grep -q -- '-e SANDBOX_ID=sh-sandbox-1' "$MOCK_LOG" ||
  fail "start_sandboxes must set a distinct SANDBOX_ID per container (the real collision bug," \
    "B5): $(cat "$MOCK_LOG")"
grep -q -- '-e RELAY_ADDR=host.containers.internal:9443' "$MOCK_LOG" ||
  fail "start_sandboxes must set RELAY_ADDR to the host's relay port, taken from" \
    "SH_RELAY_PORT in relay.env: $(cat "$MOCK_LOG")"
grep -q -- '-e SANDBOX_TOKEN=s3cr3t' "$MOCK_LOG" ||
  fail "start_sandboxes must set SANDBOX_TOKEN to match the relay's SH_RELAY_TOKEN:" \
    "$(cat "$MOCK_LOG")"
grep -q -- '--add-host host.containers.internal:host-gateway' "$MOCK_LOG" ||
  fail "start_sandboxes must map host.containers.internal explicitly (podman-run(1)" \
    "host-gateway), not rely on implicit netavark DNS: $(cat "$MOCK_LOG")"
pass "start_sandboxes: per-container SANDBOX_ID, host-reaching RELAY_ADDR, matching SANDBOX_TOKEN"

# --- missing commands fail loudly -----------------------------------------------------------
if PATH="/nonexistent" require_cmds podman 2>/dev/null; then
  fail "require_cmds should fail when podman is absent"
fi
pass "require_cmds reports missing tools"

# --- pnpm is a required command (B2) ---------------------------------------------------------
# node --import tsx src/main.ts needs tsx (a devDependency) and the workspace link: targets
# resolved -- both are products of `pnpm install`, which require_cmds never checked for.
grep -qE '^ {2}require_cmds .*\bpnpm\b' "$SCRIPT" ||
  fail "main() must require_cmds pnpm -- ExecStart needs a pnpm-installed workspace"
pass "require_cmds includes pnpm"

# --- require_build fails loudly on an unbuilt workspace, and passes on this one (B2) ---------
# Spec §9's build sequence (submodule init, pi-fork build, root pnpm install) is exactly what a
# fresh VM checkout has not run yet. require_build takes an optional root override so this test
# can point it at an empty tree without needing to break anything real.
EMPTY_ROOT="$TMP/empty-workspace"
mkdir -p "$EMPTY_ROOT"
if build_err=$(require_build "$EMPTY_ROOT" 2>&1); then
  fail "require_build should fail against an unbuilt workspace root"
fi
echo "$build_err" | grep -q 'pnpm install' || fail "require_build's message must name pnpm install (spec §9): $build_err"
echo "$build_err" | grep -q 'npm run build' || fail "require_build's message must name pi-fork's npm run build (spec §9): $build_err"
pass "require_build fails loudly and names spec §9's commands"

# The EMPTY_ROOT case above already covers require_build's failure path, and main()'s
# end-to-end test below covers its success path against a fabricated tree -- this assertion is
# guarded (not dropped) because it is the only one that exercises require_build against the
# REAL monorepo layout (three real relative paths, not paths this test invented), which is
# worth keeping for local/dev regression coverage. It is guarded because that real coverage
# depends on this worktree actually being built, which CI's toolchain-free deploy-scripts job
# (no repo-init step for pi-fork, no setup-node, no pnpm install, no pi-fork build -- see
# .github/workflows/ci.yml) deliberately never does; asserting it unconditionally would couple
# a script-testing job to a built workspace, inverting that job's own reason to exist.
REAL_ROOT="$(cd "$VM_DIR/../.." && pwd)"
if [[ -d "$REAL_ROOT/packages/supervisor/node_modules" &&
  -d "$REAL_ROOT/pi-fork/packages/ai/dist" &&
  -d "$REAL_ROOT/pi-fork/packages/coding-agent/dist" ]]; then
  require_build "$REAL_ROOT" ||
    fail "require_build must pass against this worktree, which is already built"
  pass "require_build passes against a built workspace"
else
  echo "skip - require_build-against-a-built-workspace: this worktree is not built here (no" \
    "pnpm install / pi-fork build -- expected in CI's toolchain-free deploy-scripts job);" \
    "covered instead by the EMPTY_ROOT case above and the fabricated-tree case in main()'s" \
    "end-to-end test below" >&2
fi

# --- require_root fails for a non-root uid and passes for uid 0 (B3) -------------------------
# The README shows a bare invocation with no `sudo`, but install -d -m 0750
# /etc/serverless-harness and systemctl enable both need root -- the script must say so plainly
# rather than dying on a confusing `install` permission error. require_root takes an optional
# uid override so this is testable without actually running as root or as another user.
if require_root 1000 2>/dev/null; then
  fail "require_root should fail for a non-root uid"
fi
require_root 0 || fail "require_root should pass for uid 0"
pass "require_root rejects non-root, accepts uid 0"

# --- admin listener (Task 11): loopback only -------------------------------------------------
# Unauthenticated, and it echoes configuration. Bound to 0.0.0.0 on a cloud VM it is a
# configuration disclosure to the whole subnet, and no unit test can see the difference.
ADMIN_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/packages/supervisor/src/admin.ts"
if grep -q "listen(.*'127\.0\.0\.1'" "$ADMIN_SRC"; then
  pass "admin listener binds 127.0.0.1"
else
  fail "admin /metrics must bind 127.0.0.1 explicitly (found: $(grep -n 'listen(' "$ADMIN_SRC"))"
fi

# The unit file must not publish the admin port, and must not set it equal to PORT -- readConfig
# throws on the latter, which would be a boot failure discovered on the VM rather than here.
if grep -q 'SH_ADMIN_PORT' "$UNIT_SUPERVISOR" || grep -q 'SH_ADMIN_PORT' "$ENV_SRC_DIR/supervisor.env.example"; then
  ADMIN_PORT="$(grep -ho 'SH_ADMIN_PORT=[0-9]*' "$UNIT_SUPERVISOR" "$ENV_SRC_DIR/supervisor.env.example" |
    head -1 | cut -d= -f2)"
  DATA_PORT="$(grep -ho '\bPORT=[0-9]*' "$UNIT_SUPERVISOR" "$ENV_SRC_DIR/supervisor.env.example" |
    head -1 | cut -d= -f2)"
  if [ "$ADMIN_PORT" != "$DATA_PORT" ]; then
    pass "SH_ADMIN_PORT=$ADMIN_PORT differs from PORT=$DATA_PORT"
  else
    fail "SH_ADMIN_PORT equals PORT ($DATA_PORT): readConfig throws at boot"
  fi
else
  pass "unit file leaves SH_ADMIN_PORT at its 8081 default"
fi

# --- start_services enables the supervisor WITHOUT --now, but starts the relay (B4) ----------
# SH_TURNS_PER_WORKER ships empty on purpose and readConfig throws on blank, so the supervisor
# unit is EXPECTED to fail until the operator sets it. Restart=always + RestartSec=2 with no
# StartLimitIntervalSec=0 means systemd's default 5-starts-in-10s limit trips in about ten
# seconds if we `enable --now` it, after which the README's own `systemctl start
# sh-supervisor.service` is refused with "start request repeated too quickly" until
# `systemctl reset-failed`. Enabling without --now sidesteps the crash loop entirely: the unit
# is wired into multi-user.target for the next boot, but this run does not start it.
: >"$MOCK_LOG"
start_services
grep -qE '^systemctl enable --now sh-relay\.service$' "$MOCK_LOG" ||
  fail "start_services must enable --now the relay unit: $(cat "$MOCK_LOG")"
grep -qE '^systemctl enable sh-supervisor\.service$' "$MOCK_LOG" ||
  fail "start_services must enable (without --now) the supervisor unit: $(cat "$MOCK_LOG")"
grep -qE '^systemctl enable --now sh-supervisor\.service$' "$MOCK_LOG" &&
  fail "start_services must NOT --now the supervisor unit (guaranteed crash loop while" \
    "SH_TURNS_PER_WORKER is unset): $(cat "$MOCK_LOG")"
pass "supervisor enabled without --now, relay enabled --now"

# --- main(), end to end, against mocks (last: exercises the real call order) ---------------
# require_cmds also needs `install` and `node`, which are on the real PATH (appended after the
# mock dir above) and deliberately not mocked here.
export SH_UNIT_DIR="$TMP/units2" SH_ENV_DIR="$TMP/etc2"
mkdir -p "$SH_UNIT_DIR" "$SH_ENV_DIR"
# Pre-seed relay.env with a token before main() runs: install_env_file never clobbers an
# existing file, so this stands in for an operator who has already set SH_RELAY_TOKEN --
# without it, main() would (correctly, per B5) refuse to start any sandbox containers, and
# this end-to-end run is checking the happy path's step ordering, not that refusal.
cp "$ENV_SRC_DIR/relay.env.example" "$SH_ENV_DIR/relay.env"
echo 'SH_RELAY_TOKEN=e2e-token' >>"$SH_ENV_DIR/relay.env"
# require_build (called inside main() with zero args) would otherwise resolve against this real
# worktree via SCRIPT_DIR/../.. -- exactly the coupling item 1 exists to break for CI's
# toolchain-free deploy-scripts job. Point it at a fabricated tree with just the three
# directories require_build probes, so this end-to-end run does not depend on pnpm install /
# pi-fork build having actually happened in this worktree.
FAKE_BUILT_ROOT="$TMP/fake-built-root"
mkdir -p "$FAKE_BUILT_ROOT/packages/supervisor/node_modules" \
  "$FAKE_BUILT_ROOT/pi-fork/packages/ai/dist" \
  "$FAKE_BUILT_ROOT/pi-fork/packages/coding-agent/dist"
export SH_REPO_ROOT="$FAKE_BUILT_ROOT"
: >"$MOCK_LOG"
main_output=$(main 2>&1)

grep -q 'id -u' "$MOCK_LOG" || fail "main() did not check for root (require_root)"
grep -q 'getent passwd harness' "$MOCK_LOG" || fail "main() did not check for the harness account"
[[ -f "$SH_UNIT_DIR/sh-supervisor.service" ]] || fail "main() did not install the supervisor unit"
[[ -f "$SH_UNIT_DIR/sh-relay.service" ]] || fail "main() did not install the relay unit"
[[ -f "$SH_ENV_DIR/supervisor.env" ]] || fail "main() did not install supervisor.env"
[[ -f "$SH_ENV_DIR/relay.env" ]] || fail "main() did not install relay.env"

reload_line=$(grep -n 'systemctl daemon-reload' "$MOCK_LOG" | head -1 | cut -d: -f1)
redis_line=$(grep -n 'podman run .*sh-redis' "$MOCK_LOG" | head -1 | cut -d: -f1)
relay_enable_line=$(grep -n 'systemctl enable --now sh-relay.service' "$MOCK_LOG" | head -1 | cut -d: -f1)
[[ -n "$reload_line" && -n "$redis_line" && -n "$relay_enable_line" ]] ||
  fail "main() did not perform the expected steps: $(cat "$MOCK_LOG")"
((reload_line < redis_line)) ||
  fail "main() must install units (daemon-reload) before starting Redis"
((redis_line < relay_enable_line)) ||
  fail "main() must start Redis before enabling the relay unit"
grep -q -- '-e SANDBOX_TOKEN=e2e-token' "$MOCK_LOG" ||
  fail "main() did not pass the pre-seeded SH_RELAY_TOKEN through to the sandbox containers" \
    "(B5 / require_relay_token wiring): $(cat "$MOCK_LOG")"
pass "main() end to end: harness-account check, both units, both env files, correct ordering"

# The closing message must match the behaviour we actually land on: the supervisor is enabled
# but not started, so the message must say to set SH_TURNS_PER_WORKER and then start it --
# never "restart", which implies it is already running.
echo "$main_output" | grep -qi 'SH_TURNS_PER_WORKER' ||
  fail "closing message must tell the operator to set SH_TURNS_PER_WORKER: $main_output"
echo "$main_output" | grep -qE 'systemctl start sh-supervisor\.service' ||
  fail "closing message must say 'systemctl start' (not restart -- it was never started): $main_output"
pass "closing message matches the enable-without-start behaviour"

echo "all setup-vm.sh tests passed"
