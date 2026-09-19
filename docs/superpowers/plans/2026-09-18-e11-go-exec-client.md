# E11 persistent-connection Go Exec client — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `grpcurl`'s one-process-per-Exec cost in E11's timed window with a Go client holding one gRPC connection per rung, opt-in, so the driver stops being the thing the density sweep measures.

**Architecture:** A new `remote-worker/cmd/exec-driver` binary reads a per-rung JSON plan, dials once, runs one goroutine per slot, and appends the existing `<ms> <status> <cause>` lines to each slot's times file. `deploy/microvm/e11-density.sh` writes that plan before `wall_t0` and, when `SH_E11_EXEC_CLIENT=go`, runs the binary in place of its `c` subshells. Everything downstream of the times files — warmup trimming, `percentile`, `execErrorsByCause`, the sampler bracket, the record writer — is untouched by construction.

**Tech Stack:** Go 1.26 (`remote-worker` module, `gen/go/sandbox/v1` stubs, `google.golang.org/grpc` v1.83.2), bash 5 + `python3` for the driver, vitest 2.x for the one TypeScript touch.

**Spec:** `docs/superpowers/specs/2026-09-18-e11-go-exec-client-design.md`

## Global Constraints

- **The times-file format is frozen:** one line per Exec, `<ms> <status> <cause>`, `status` ∈ `ok`|`err`, `cause` is `-` on success. Written in issue order. Any deviation breaks `run_density_rung`'s aggregation silently.
- **`req_id` = `reqBase + 1 + i`** for call `i` (0-based). `reqBase` itself belongs to converge. Two concurrent Execs sharing a `req_id` once left a run wedged for **33 minutes**, so disjointness is validated, not assumed.
- **Command for call `i` is `mix[i % len(mix)]`** — reproduces bash's cycle-and-truncate over the 7-command mix.
- **Nothing new may fork inside the timed window.** The window is the lines of `run_density_rung` strictly between the `wall_t0="` and `wall_t1="` stamps; `deploy/microvm/tests/e11-density.test.sh:845` is the regression guard and this plan extends it.
- **Opt-in only.** `SH_E11_EXEC_CLIENT` defaults to `grpcurl`. The `grpcurl` subshell loop stays **verbatim** — it is the reference the comparison is against.
- **`drivingModel` stays `'closed-loop-per-slot'`.** Open-loop driving is out of scope.
- **Converge (phase 1) stays on `grpcurl`.** It is already outside the timed window.
- **No new codegen.** Build against the existing `gen/go/sandbox/v1` package, as `cmd/null-responder` does.
- **`shellcheck -x -S warning` clean** (enforced by `deploy/microvm/tests/e11-density.test.sh:149` and by pre-commit).
- **Formatting:** `gofmt` for Go (there is no gofmt pre-commit hook — run it yourself); the pinned Prettier 3.9.6 for Markdown and TypeScript. This worktree has no `node_modules`, so use `/Users/paolo/Projects/aiplatform/serverless-harness/node_modules/.bin/prettier`.
- **Commits:** `git commit -s` (DCO) and `Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>` — never `Co-Authored-By`.
- **Do not run `make fmt` or `make lint`** from this worktree; both walk the whole tree and another session is live on `e13-integrate`. Run the targeted commands each task names.

## File Structure

| File                                          | Status | Responsibility                                                                                                                           |
| --------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `remote-worker/cmd/exec-driver/cause.go`      | create | Map an error message to E11's cause vocabulary. Mirrors a bash contract, so it gets its own file a reader can diff against the original. |
| `remote-worker/cmd/exec-driver/cause_test.go` | create | Every row of the vocabulary, plus order-sensitivity.                                                                                     |
| `remote-worker/cmd/exec-driver/plan.go`       | create | The rung plan struct, its JSON tags, and the refusals that keep a malformed rung from being measured.                                    |
| `remote-worker/cmd/exec-driver/plan_test.go`  | create | Round-trip a golden plan; assert each refusal fires.                                                                                     |
| `remote-worker/cmd/exec-driver/drive.go`      | create | Dial once to READY, one goroutine per slot, per-Exec timing, times/err file writing.                                                     |
| `remote-worker/cmd/exec-driver/drive_test.go` | create | Drive a real in-test null responder; assert line counts, format, order, `req_id` disjointness.                                           |
| `remote-worker/cmd/exec-driver/main.go`       | create | Flags, plan load, exit status.                                                                                                           |
| `deploy/microvm/e11-density.sh`               | modify | Client selection, build, plan writing, the phase-2 branch, the record field.                                                             |
| `deploy/microvm/tests/e11-density.test.sh`    | modify | Opt-in default, refusals, plan contents, fork-guard extension, seam closure.                                                             |
| `experiments/src/microvm-density.ts`          | modify | `execClient?: string` on `RungSample`.                                                                                                   |
| `experiments/test/microvm-density.test.ts`    | modify | A record carrying `execClient` still parses.                                                                                             |
| `deploy/microvm/EXPERIMENTS.md`               | modify | How to select the client; the comparison runbook; §E11 stays under repair.                                                               |

---

### Task 1: Cause classification

**Files:**

- Create: `remote-worker/cmd/exec-driver/cause.go`
- Test: `remote-worker/cmd/exec-driver/cause_test.go`

**Interfaces:**

- Consumes: nothing.
- Produces: `func causeFor(msg string) string` — returns one of `empty-workspace-key`, `memory-gate`, `max-runs`, `spawn-failure`, `vsock-short-response`, `unknown`. Tasks 3 and 8 call it.

The original it mirrors is `grpc_exec_record` in `deploy/microvm/e11-density.sh`, which greps `grpcurl`'s stderr with `grep -qi` in this exact order: `workspace_key`, `mem`, `maxruns\|max-runs\|max_runs`, `spawn`, `vsock`, else `unknown`. The order is load-bearing: a message saying `out of memory while honouring max_runs` classifies as `memory-gate` on both paths, because `mem` is tested first.

- [ ] **Step 1: Write the failing test**

Create `remote-worker/cmd/exec-driver/cause_test.go`:

```go
package main

import "testing"

// The vocabulary and the ORDER are a mirror of grpc_exec_record's grep chain in
// deploy/microvm/e11-density.sh. Both are asserted, because a reordering would be
// invisible for most messages and wrong for the overlapping ones.
func TestCauseForMirrorsTheBashVocabulary(t *testing.T) {
	for _, tc := range []struct {
		name, msg, want string
	}{
		{"workspace key refusal", "exec refused: empty workspace_key on the VM path", "empty-workspace-key"},
		{"memory gate", "budget: insufficient MemAvailable to admit a guest", "memory-gate"},
		{"max runs, no separator", "pool refused: maxruns reached", "max-runs"},
		{"max runs, hyphen", "pool refused: max-runs reached", "max-runs"},
		{"max runs, underscore", "pool refused: max_runs reached", "max-runs"},
		{"spawn failure", "Spawn of firecracker failed: exit status 1", "spawn-failure"},
		{"vsock short response", "vsock read returned 3 bytes, want 8", "vsock-short-response"},
		{"unclassified", "rpc error: code = Unavailable desc = connection refused", "unknown"},
		{"empty", "", "unknown"},
		{"case insensitive", "EMPTY WORKSPACE_KEY", "empty-workspace-key"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := causeFor(tc.msg); got != tc.want {
				t.Fatalf("causeFor(%q) = %q, want %q", tc.msg, got, tc.want)
			}
		})
	}
}

// Order sensitivity, stated as its own test so a reordering fails loudly rather than
// shifting one row of the table above. bash tests `mem` BEFORE the max-runs alternation,
// so a message containing both is memory-gate on both paths.
func TestCauseForPrefersTheEarlierRuleWhenTwoMatch(t *testing.T) {
	if got := causeFor("out of memory while honouring max_runs"); got != "memory-gate" {
		t.Fatalf("got %q, want memory-gate: mem is tested before max-runs in grpc_exec_record", got)
	}
	if got := causeFor("workspace_key missing and spawn failed"); got != "empty-workspace-key" {
		t.Fatalf("got %q, want empty-workspace-key: workspace_key is tested first", got)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd remote-worker && go test ./cmd/exec-driver/ -run TestCauseFor -v
```

Expected: FAIL — the package does not exist yet (`no Go files in .../cmd/exec-driver` or `undefined: causeFor`).

- [ ] **Step 3: Write the minimal implementation**

Create `remote-worker/cmd/exec-driver/cause.go`:

```go
package main

import "strings"

// causeFor classifies an Exec failure into the cause vocabulary E11 records as
// execErrorsByCause.
//
// It is a deliberate MIRROR of grpc_exec_record in deploy/microvm/e11-density.sh, which
// classifies by grepping grpcurl's stderr with `grep -qi` in exactly this order. Keeping the
// vocabulary and the order identical is what lets a Go-driven ladder be compared against a
// grpcurl-driven one: a different set of keys would make execErrorsByCause incomparable
// between the two clients, which is the whole point of running both (#294).
//
// The input is either a gRPC status message or an in-stream ExecError.message. A CLIENT-SIDE
// deadline matches no rule and lands in "unknown" -- the same place grpcurl's own timeout
// message lands, so the two paths agree there too.
func causeFor(msg string) string {
	m := strings.ToLower(msg)
	switch {
	case strings.Contains(m, "workspace_key"):
		return "empty-workspace-key"
	case strings.Contains(m, "mem"):
		return "memory-gate"
	case strings.Contains(m, "maxruns"), strings.Contains(m, "max-runs"), strings.Contains(m, "max_runs"):
		return "max-runs"
	case strings.Contains(m, "spawn"):
		return "spawn-failure"
	case strings.Contains(m, "vsock"):
		return "vsock-short-response"
	default:
		return "unknown"
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd remote-worker && gofmt -l ./cmd/exec-driver/ && go test ./cmd/exec-driver/ -run TestCauseFor -v
```

Expected: `gofmt -l` prints nothing; both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add remote-worker/cmd/exec-driver/cause.go remote-worker/cmd/exec-driver/cause_test.go
git commit -s -m "feat(e11): mirror grpc_exec_record's cause vocabulary in Go (#294)

Same six causes, same order. A client-side deadline lands in unknown on
both paths, as grpcurl's own timeout message does, so execErrorsByCause
stays comparable between the two clients.

Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

### Task 2: The rung plan and its refusals

**Files:**

- Create: `remote-worker/cmd/exec-driver/plan.go`
- Test: `remote-worker/cmd/exec-driver/plan_test.go`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `type slot struct { ReqBase uint64; WorkspaceKey, TimesFile, ErrFile string }` with JSON tags `reqBase`, `workspaceKey`, `timesFile`, `errFile`.
  - `type plan struct { Target, SandboxID string; ItersPerSlot, WarmupPerSlot, CallDeadlineS int; ExecTimeoutS uint32; Mix []string; Slots []slot }` with JSON tags `target`, `sandboxId`, `itersPerSlot`, `warmupPerSlot`, `callDeadlineS`, `execTimeoutS`, `mix`, `slots`.
  - `func (p *plan) callsPerSlot() int` — `ItersPerSlot + WarmupPerSlot`.
  - `func (p *plan) validate() error`
  - `func loadPlan(path string) (*plan, error)` — read, unmarshal, validate. Tasks 3 and 8 call it.

The disjointness rule: slot `k` uses `req_id`s `ReqBase_k + 1 … ReqBase_k + callsPerSlot()`, and `ReqBase_k` itself is converge's. So sorted by `ReqBase`, each slot must satisfy `next.ReqBase > prev.ReqBase + callsPerSlot()`. `slot_req_base` spaces them 1 000 000 apart, so any realistic rung passes; the check exists because the failure mode is a 33-minute wedge rather than an error.

- [ ] **Step 1: Write the failing test**

Create `remote-worker/cmd/exec-driver/plan_test.go`:

```go
package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// goldenPlan is the shape write_rung_plan emits in deploy/microvm/e11-density.sh: two
// slots 1000000 apart, the container arm's empty workspace_key, and a two-command mix.
func goldenPlan(dir string) plan {
	return plan{
		Target:        "localhost:8445",
		SandboxID:     "e11-driver-control",
		ItersPerSlot:  5,
		WarmupPerSlot: 2,
		ExecTimeoutS:  30,
		CallDeadlineS: 45,
		Mix:           []string{"true", "cat /etc/hostname"},
		Slots: []slot{
			{ReqBase: 1000000, WorkspaceKey: "", TimesFile: filepath.Join(dir, "slot-1.times"), ErrFile: filepath.Join(dir, "slot-1.err")},
			{ReqBase: 2000000, WorkspaceKey: "", TimesFile: filepath.Join(dir, "slot-2.times"), ErrFile: filepath.Join(dir, "slot-2.err")},
		},
	}
}

func writePlan(t *testing.T, dir string, p plan) string {
	t.Helper()
	b, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	path := filepath.Join(dir, "plan.json")
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	return path
}

func TestLoadPlanRoundTripsEveryField(t *testing.T) {
	dir := t.TempDir()
	want := goldenPlan(dir)
	got, err := loadPlan(writePlan(t, dir, want))
	if err != nil {
		t.Fatalf("loadPlan: %v", err)
	}
	if got.Target != want.Target || got.SandboxID != want.SandboxID {
		t.Errorf("target/sandboxId = %q/%q, want %q/%q", got.Target, got.SandboxID, want.Target, want.SandboxID)
	}
	if got.ItersPerSlot != 5 || got.WarmupPerSlot != 2 || got.callsPerSlot() != 7 {
		t.Errorf("iters/warmup/calls = %d/%d/%d, want 5/2/7", got.ItersPerSlot, got.WarmupPerSlot, got.callsPerSlot())
	}
	if got.ExecTimeoutS != 30 || got.CallDeadlineS != 45 {
		t.Errorf("execTimeoutS/callDeadlineS = %d/%d, want 30/45", got.ExecTimeoutS, got.CallDeadlineS)
	}
	if len(got.Mix) != 2 || got.Mix[1] != "cat /etc/hostname" {
		t.Errorf("mix = %q, want the two-command golden mix", got.Mix)
	}
	if len(got.Slots) != 2 || got.Slots[1].ReqBase != 2000000 {
		t.Errorf("slots = %+v, want two slots 1000000 apart", got.Slots)
	}
}

// Every refusal, with the substring an operator would search the message for. A plan that
// is wrong in any of these ways would otherwise be MEASURED, and a rung recorded from it.
func TestLoadPlanRefusals(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*plan)
		want   string
	}{
		{"no target", func(p *plan) { p.Target = "" }, "target"},
		{"no sandboxId", func(p *plan) { p.SandboxID = "" }, "sandboxId"},
		{"empty mix", func(p *plan) { p.Mix = nil }, "mix is empty"},
		{"no slots", func(p *plan) { p.Slots = nil }, "no slots"},
		{"zero iters", func(p *plan) { p.ItersPerSlot = 0 }, "itersPerSlot"},
		{"negative warmup", func(p *plan) { p.WarmupPerSlot = -1 }, "warmupPerSlot"},
		{"zero deadline", func(p *plan) { p.CallDeadlineS = 0 }, "callDeadlineS"},
		{"no times file", func(p *plan) { p.Slots[0].TimesFile = "" }, "timesFile"},
		{"no err file", func(p *plan) { p.Slots[0].ErrFile = "" }, "errFile"},
		{"duplicate reqBase", func(p *plan) { p.Slots[1].ReqBase = p.Slots[0].ReqBase }, "req_id"},
		{"overlapping reqBase ranges", func(p *plan) { p.Slots[1].ReqBase = p.Slots[0].ReqBase + 3 }, "req_id"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			p := goldenPlan(dir)
			tc.mutate(&p)
			_, err := loadPlan(writePlan(t, dir, p))
			if err == nil {
				t.Fatalf("loadPlan accepted a plan with %s", tc.name)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q does not mention %q, so an operator cannot find the field", err, tc.want)
			}
		})
	}
}

// A reqBase range that ENDS exactly where the next one BEGINS is legal: slot k uses
// reqBase+1 .. reqBase+calls, and reqBase itself belongs to converge, so prev+calls == next
// would have the next slot's converge collide with the previous slot's last Exec. Assert the
// boundary explicitly, in both directions, so the off-by-one cannot drift.
func TestLoadPlanReqIDBoundaryIsExact(t *testing.T) {
	dir := t.TempDir()
	tooClose := goldenPlan(dir)
	tooClose.Slots[1].ReqBase = tooClose.Slots[0].ReqBase + callsOf(tooClose)
	if _, err := loadPlan(writePlan(t, dir, tooClose)); err == nil {
		t.Fatal("a next reqBase equal to prev.reqBase+calls must be refused: converge would collide with the last Exec")
	}
	justEnough := goldenPlan(dir)
	justEnough.Slots[1].ReqBase = justEnough.Slots[0].ReqBase + callsOf(justEnough) + 1
	if _, err := loadPlan(writePlan(t, dir, justEnough)); err != nil {
		t.Fatalf("a next reqBase one past the previous slot's last Exec must be accepted: %v", err)
	}
}

func callsOf(p plan) uint64 { return uint64(p.callsPerSlot()) }

func TestLoadPlanReportsAMissingFile(t *testing.T) {
	if _, err := loadPlan(filepath.Join(t.TempDir(), "absent.json")); err == nil {
		t.Fatal("loadPlan accepted a path that does not exist")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd remote-worker && go test ./cmd/exec-driver/ -run 'TestLoadPlan' -v
```

Expected: FAIL — `undefined: plan`, `undefined: slot`, `undefined: loadPlan`.

- [ ] **Step 3: Write the minimal implementation**

Create `remote-worker/cmd/exec-driver/plan.go`:

```go
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
)

// slot is one of the rung's c concurrent issuers. It carries the identity
// deploy/microvm/e11-density.sh derived for it -- slot_req_base and slot_workspace_key --
// rather than recomputing it here: those derivations live in ONE place each precisely so two
// slots cannot drift into sharing a workspace or a req_id space.
type slot struct {
	ReqBase      uint64 `json:"reqBase"`
	WorkspaceKey string `json:"workspaceKey"`
	TimesFile    string `json:"timesFile"`
	ErrFile      string `json:"errFile"`
}

// plan is ONE rung's whole instruction set, written by write_rung_plan before the driver
// stamps wall_t0. It is a file rather than a flag set because per-slot workspace keys are
// slot_run_id output on the microvm arm: a naming template in Go would be a second copy of
// bash's naming, and 64 repeated flags would be the same data with worse quoting.
type plan struct {
	Target        string   `json:"target"`
	SandboxID     string   `json:"sandboxId"`
	ItersPerSlot  int      `json:"itersPerSlot"`
	WarmupPerSlot int      `json:"warmupPerSlot"`
	ExecTimeoutS  uint32   `json:"execTimeoutS"`
	CallDeadlineS int      `json:"callDeadlineS"`
	Mix           []string `json:"mix"`
	Slots         []slot   `json:"slots"`
}

// callsPerSlot is how many Execs each slot issues: the steady-state iterations plus the
// warmup the driver trims off the front of every times file.
func (p *plan) callsPerSlot() int { return p.ItersPerSlot + p.WarmupPerSlot }

func (p *plan) validate() error {
	if p.Target == "" {
		return fmt.Errorf("plan has no target: there is nothing to dial, so every Exec would time a client-side error")
	}
	if p.SandboxID == "" {
		return fmt.Errorf("plan has no sandboxId: the relay routes by it, so every Exec would be refused")
	}
	if len(p.Mix) == 0 {
		return fmt.Errorf("plan mix is empty: every slot would issue no Exec and the rung would record an absent measurement as a fast one")
	}
	if p.ItersPerSlot <= 0 {
		return fmt.Errorf("plan itersPerSlot is %d: a rung with no steady-state iterations has no distribution to take a p95 of", p.ItersPerSlot)
	}
	if p.WarmupPerSlot < 0 {
		return fmt.Errorf("plan warmupPerSlot is %d: the driver trims this many lines off the front of every times file, so a negative value is not a shorter warmup, it is a corrupt trim", p.WarmupPerSlot)
	}
	if p.CallDeadlineS <= 0 {
		return fmt.Errorf("plan callDeadlineS is %d: without a per-call deadline a wedged Exec hangs the whole ladder instead of failing one rung", p.CallDeadlineS)
	}
	if len(p.Slots) == 0 {
		return fmt.Errorf("plan has no slots: a rung with no issuers would measure nothing and report a wall time")
	}
	for i, s := range p.Slots {
		if s.TimesFile == "" {
			return fmt.Errorf("plan slot %d has no timesFile: its Exec timings would have nowhere to go and the rung would aggregate the other slots as if they were all of it", i+1)
		}
		if s.ErrFile == "" {
			return fmt.Errorf("plan slot %d has no errFile: a failing Exec's message would be lost and execErrorsByCause would say unknown with nothing to look at", i+1)
		}
	}
	return p.validateReqIDRanges()
}

// validateReqIDRanges refuses any two slots whose req_id spaces touch.
//
// The relay demultiplexes responses BY req_id, so uniqueness is the caller's job. On the
// validation rig two concurrent Execs sharing a req_id had one of the pair receive the
// other's chunks and hang for 33 MINUTES. Slot k issues reqBase_k+1 .. reqBase_k+calls, and
// reqBase_k itself is converge's, so a next base at or below prev+calls collides.
func (p *plan) validateReqIDRanges() error {
	calls := uint64(p.callsPerSlot())
	ordered := make([]slot, len(p.Slots))
	copy(ordered, p.Slots)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].ReqBase < ordered[j].ReqBase })
	for i := 1; i < len(ordered); i++ {
		prev, cur := ordered[i-1], ordered[i]
		if cur.ReqBase <= prev.ReqBase+calls {
			return fmt.Errorf(
				"plan slots have overlapping req_id spaces: base %d issues %d..%d and the next base is %d. The relay demultiplexes by req_id, so a collision detaches one caller and interleaves both execs (a 33-minute wedge on the validation rig). slot_req_base spaces bases 1000000 apart; %d calls per slot needs at least that much room",
				prev.ReqBase, prev.ReqBase+1, prev.ReqBase+calls, cur.ReqBase, calls)
		}
	}
	return nil
}

// loadPlan reads and validates a rung plan. A plan that cannot be trusted is refused HERE,
// before a single Exec is timed, because the alternative is a recorded rung whose numbers
// mean something other than what the record says.
func loadPlan(path string) (*plan, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading the rung plan: %w", err)
	}
	var p plan
	if err := json.Unmarshal(b, &p); err != nil {
		return nil, fmt.Errorf("parsing the rung plan at %s: %w", path, err)
	}
	if err := p.validate(); err != nil {
		return nil, err
	}
	return &p, nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd remote-worker && gofmt -l ./cmd/exec-driver/ && go test ./cmd/exec-driver/ -v
```

Expected: `gofmt -l` prints nothing; every `TestLoadPlan*` and `TestCauseFor*` PASSES.

- [ ] **Step 5: Commit**

```bash
git add remote-worker/cmd/exec-driver/plan.go remote-worker/cmd/exec-driver/plan_test.go
git commit -s -m "feat(e11): the rung plan exec-driver reads, and its refusals (#294)

Slot identity travels in the plan rather than being recomputed in Go: the
three derivations live in one place each in e11-density.sh so two slots
cannot drift into sharing a workspace or a req_id space.

validateReqIDRanges refuses touching req_id spaces before any Exec is
timed. The relay demultiplexes by req_id and a collision once left a run
wedged for 33 minutes, which is a failure mode no measurement survives.

Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

### Task 3: The issuer and the binary

**Files:**

- Create: `remote-worker/cmd/exec-driver/drive.go`
- Create: `remote-worker/cmd/exec-driver/main.go`
- Test: `remote-worker/cmd/exec-driver/drive_test.go`

**Interfaces:**

- Consumes: `causeFor` (Task 1); `plan`, `slot`, `loadPlan`, `callsPerSlot` (Task 2).
- Produces:
  - `func dialReady(ctx context.Context, target string) (*grpc.ClientConn, error)`
  - `type execOutcome struct { ms int64; status, cause, errMsg string }`
  - `func oneExec(ctx context.Context, client pb.SandboxExecClient, p *plan, s slot, reqID uint64, cmd string) execOutcome`
  - `func runSlot(ctx context.Context, client pb.SandboxExecClient, p *plan, s slot) error`
  - `func drive(ctx context.Context, p *plan) error`
  - the `exec-driver` binary itself, invoked as `exec-driver --plan <path>`. Tasks 4–9 depend on that command line.

Three properties the tests pin, because each is a way the measurement could be wrong while looking right:

1. **The stream is drained to `io.EOF`,** not stopped at `End`. `grpcurl` drains; stopping early would shorten measured latency for a reason unrelated to the change being measured.
2. **An in-stream `ExecEvent.error` is `status=err`.** `packages/sandbox-relay/src/relay.ts:110`'s `routeExec` yields that event and then returns a gRPC **OK** status, so `grpcurl` exits 0 and the bash path records `ok`. The null-responder never sends one, so this cannot affect #294's comparison — and it means the Go path can be right for free.
3. **Per-Exec errors are recorded, not fatal.** `grpc_exec_record` never returns non-zero. The binary exits non-zero only on a setup failure, which is what `run_density_rung` turns into its refusal.

- [ ] **Step 1: Write the failing test**

Create `remote-worker/cmd/exec-driver/drive_test.go`:

```go
package main

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "github.com/kagenti/serverless-harness/gen/go/sandbox/v1"
)

// fakeExec is a null responder with a recorder. It answers like
// remote-worker/cmd/null-responder -- one End carrying the request's own req_id -- and
// additionally remembers every (reqID, command) it saw, so a test can assert what the client
// actually put on the wire. behave lets one test make it fail in a specific way.
// seenExec is a PLAIN struct, deliberately not pb.Exec: protobuf messages embed a
// protoimpl.MessageState containing a no-copy guard, so recording them by value trips
// go vet's copylocks check and the verification step would fail.
type seenExec struct {
	reqID        uint64
	command      string
	workspaceKey string
	timeoutS     uint32
}

type fakeExec struct {
	pb.UnimplementedSandboxExecServer
	mu     sync.Mutex
	seen   []seenExec
	behave func(reqID uint64) (inStreamErr string, statusErr error)
}

func (f *fakeExec) Exec(req *pb.ExecRequest, stream grpc.ServerStreamingServer[pb.ExecEvent]) error {
	e := req.GetExec()
	f.mu.Lock()
	f.seen = append(f.seen, seenExec{reqID: e.GetReqId(), command: e.GetCommand(), workspaceKey: e.GetWorkspaceKey(), timeoutS: e.GetTimeoutS()})
	f.mu.Unlock()

	if f.behave != nil {
		inStream, statusErr := f.behave(e.GetReqId())
		if statusErr != nil {
			return statusErr
		}
		if inStream != "" {
			return stream.Send(&pb.ExecEvent{Event: &pb.ExecEvent_Error{Error: &pb.ExecError{ReqId: e.GetReqId(), Message: inStream}}})
		}
	}
	return stream.Send(&pb.ExecEvent{Event: &pb.ExecEvent_End{End: &pb.End{ReqId: e.GetReqId(), ExitCode: 0}}})
}

func (f *fakeExec) snapshot() []seenExec {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]seenExec, len(f.seen))
	copy(out, f.seen)
	return out
}

// startFake serves fakeExec on an ephemeral loopback port and returns its target string.
func startFake(t *testing.T, f *fakeExec) string {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	srv := grpc.NewServer()
	pb.RegisterSandboxExecServer(srv, f)
	go func() { _ = srv.Serve(lis) }()
	t.Cleanup(srv.Stop)
	return lis.Addr().String()
}

// planFor builds a plan pointing at target with c slots, bases 1000000 apart exactly as
// slot_req_base does.
func planFor(t *testing.T, target string, c, iters, warmup int, mix []string) *plan {
	t.Helper()
	dir := t.TempDir()
	p := &plan{
		Target:        target,
		SandboxID:     "e11-driver-control",
		ItersPerSlot:  iters,
		WarmupPerSlot: warmup,
		ExecTimeoutS:  30,
		CallDeadlineS: 10,
		Mix:           mix,
	}
	for i := 1; i <= c; i++ {
		p.Slots = append(p.Slots, slot{
			ReqBase:   uint64(i) * 1000000,
			TimesFile: filepath.Join(dir, fmt.Sprintf("slot-%d.times", i)),
			ErrFile:   filepath.Join(dir, fmt.Sprintf("slot-%d.err", i)),
		})
	}
	return p
}

func readLines(t *testing.T, path string) []string {
	t.Helper()
	fh, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer func() { _ = fh.Close() }()
	var out []string
	sc := bufio.NewScanner(fh)
	for sc.Scan() {
		out = append(out, sc.Text())
	}
	if err := sc.Err(); err != nil {
		t.Fatalf("scan %s: %v", path, err)
	}
	return out
}

// The times-file contract, which everything downstream of this binary depends on:
// iters+warmup lines per slot, "<ms> <status> <cause>", ok/- on success.
func TestDriveWritesTheFrozenTimesFileFormat(t *testing.T) {
	f := &fakeExec{}
	p := planFor(t, startFake(t, f), 3, 5, 2, []string{"true", "cat /etc/hostname"})
	if err := drive(context.Background(), p); err != nil {
		t.Fatalf("drive: %v", err)
	}
	for i, s := range p.Slots {
		lines := readLines(t, s.TimesFile)
		if len(lines) != 7 {
			t.Fatalf("slot %d wrote %d lines, want iters+warmup = 7", i+1, len(lines))
		}
		for n, l := range lines {
			fields := strings.Fields(l)
			if len(fields) != 3 {
				t.Fatalf("slot %d line %d is %q, want three fields <ms> <status> <cause>", i+1, n+1, l)
			}
			if fields[1] != "ok" || fields[2] != "-" {
				t.Fatalf("slot %d line %d is %q, want status ok and cause - against a null responder", i+1, n+1, l)
			}
			if _, err := time.ParseDuration(fields[0] + "ms"); err != nil {
				t.Fatalf("slot %d line %d has a non-numeric ms field %q", i+1, n+1, fields[0])
			}
		}
	}
}

// req_id disjointness, observed SERVER-SIDE rather than inferred from the plan: every slot
// must issue reqBase+1 .. reqBase+calls and nothing else, and no two slots may share one.
func TestDriveIssuesDisjointReqIDsStartingOnePastTheBase(t *testing.T) {
	f := &fakeExec{}
	p := planFor(t, startFake(t, f), 4, 3, 1, []string{"true"})
	if err := drive(context.Background(), p); err != nil {
		t.Fatalf("drive: %v", err)
	}
	seen := map[uint64]int{}
	for _, e := range f.snapshot() {
		seen[e.reqID]++
	}
	if len(seen) != 4*4 {
		t.Fatalf("server saw %d distinct req_ids, want 4 slots x 4 calls = 16", len(seen))
	}
	for id, n := range seen {
		if n != 1 {
			t.Fatalf("req_id %d was issued %d times: the relay demultiplexes by req_id, so a repeat is a collision", id, n)
		}
	}
	for _, s := range p.Slots {
		if seen[s.ReqBase] != 0 {
			t.Fatalf("req_id %d (a slot's own reqBase) was issued: the base belongs to converge, Execs start one past it", s.ReqBase)
		}
		for k := uint64(1); k <= 4; k++ {
			if seen[s.ReqBase+k] != 1 {
				t.Fatalf("req_id %d missing: slot with base %d must issue base+1..base+4", s.ReqBase+k, s.ReqBase)
			}
		}
	}
}

// The mix cycles and truncates exactly as bash's `while issued < want; for mi in mix` does.
func TestDriveCyclesTheMixAndTruncatesMidCycle(t *testing.T) {
	f := &fakeExec{}
	mix := []string{"a", "b", "c"}
	p := planFor(t, startFake(t, f), 1, 4, 0, mix)
	if err := drive(context.Background(), p); err != nil {
		t.Fatalf("drive: %v", err)
	}
	var got []string
	for _, e := range f.snapshot() {
		got = append(got, e.command)
	}
	want := []string{"a", "b", "c", "a"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("commands = %v, want %v (cycle then truncate mid-cycle)", got, want)
	}
}

// The workspace_key the plan carries reaches the wire unchanged -- the microvm arm REFUSES an
// empty one, so a client that dropped it would turn every microvm Exec into a refusal.
func TestDriveSendsThePlansWorkspaceKeyAndExecTimeout(t *testing.T) {
	f := &fakeExec{}
	p := planFor(t, startFake(t, f), 1, 1, 0, []string{"true"})
	p.Slots[0].WorkspaceKey = "e11-microvm-d2-ram256-c1-slot1"
	if err := drive(context.Background(), p); err != nil {
		t.Fatalf("drive: %v", err)
	}
	seen := f.snapshot()
	if len(seen) != 1 {
		t.Fatalf("server saw %d Execs, want 1", len(seen))
	}
	if seen[0].workspaceKey != "e11-microvm-d2-ram256-c1-slot1" {
		t.Fatalf("workspace_key = %q, want the plan's value", seen[0].workspaceKey)
	}
	if seen[0].timeoutS != 30 {
		t.Fatalf("timeout_s = %d, want the plan's execTimeoutS of 30", seen[0].timeoutS)
	}
}

// An in-stream ExecError is a FAILED Exec. The relay yields it and then returns a gRPC OK
// status (packages/sandbox-relay/src/relay.ts routeExec), which is why grpcurl exits 0 and
// the bash path records this as ok. The null-responder never sends one, so classifying it
// correctly here cannot affect the driver-control comparison.
func TestDriveClassifiesAnInStreamExecErrorAsFailure(t *testing.T) {
	f := &fakeExec{behave: func(uint64) (string, error) {
		return "vmpool refused: empty workspace_key", nil
	}}
	p := planFor(t, startFake(t, f), 1, 2, 0, []string{"true"})
	if err := drive(context.Background(), p); err != nil {
		t.Fatalf("drive must not fail the rung over per-Exec errors: %v", err)
	}
	for n, l := range readLines(t, p.Slots[0].TimesFile) {
		fields := strings.Fields(l)
		if fields[1] != "err" || fields[2] != "empty-workspace-key" {
			t.Fatalf("line %d is %q, want status err and cause empty-workspace-key", n+1, l)
		}
	}
	errBody, err := os.ReadFile(p.Slots[0].ErrFile)
	if err != nil {
		t.Fatalf("read err file: %v", err)
	}
	if !strings.Contains(string(errBody), "empty workspace_key") {
		t.Fatalf("err file %q does not carry the message an operator would read", errBody)
	}
}

// A gRPC status error is also recorded rather than fatal, and it is classified from the
// status message.
func TestDriveRecordsAStatusErrorWithoutFailingTheRung(t *testing.T) {
	f := &fakeExec{behave: func(uint64) (string, error) {
		return "", status.Error(codes.ResourceExhausted, "pool refused: max_runs reached")
	}}
	p := planFor(t, startFake(t, f), 2, 2, 0, []string{"true"})
	if err := drive(context.Background(), p); err != nil {
		t.Fatalf("drive must not fail the rung over per-Exec errors: %v", err)
	}
	for _, s := range p.Slots {
		for n, l := range readLines(t, s.TimesFile) {
			if fields := strings.Fields(l); fields[1] != "err" || fields[2] != "max-runs" {
				t.Fatalf("line %d is %q, want status err and cause max-runs", n+1, l)
			}
		}
	}
}

// A rung with a mix of outcomes keeps them in ISSUE ORDER, because the driver trims warmup
// off the FRONT of this file by line position.
func TestDrivePreservesIssueOrder(t *testing.T) {
	f := &fakeExec{behave: func(reqID uint64) (string, error) {
		if reqID%2 == 0 {
			return "vsock read returned 3 bytes", nil
		}
		return "", nil
	}}
	p := planFor(t, startFake(t, f), 1, 4, 0, []string{"true"})
	if err := drive(context.Background(), p); err != nil {
		t.Fatalf("drive: %v", err)
	}
	var statuses []string
	for _, l := range readLines(t, p.Slots[0].TimesFile) {
		statuses = append(statuses, strings.Fields(l)[1])
	}
	// req_ids are 1000001..1000004: odd, even, odd, even -> ok, err, ok, err.
	want := "ok,err,ok,err"
	if strings.Join(statuses, ",") != want {
		t.Fatalf("statuses = %v, want %s", statuses, want)
	}
}

// A setup failure IS fatal: an unreachable target must not produce a times file full of
// plausible error lines that a rung would then aggregate and record.
func TestDriveFailsWhenTheTargetIsUnreachable(t *testing.T) {
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	target := lis.Addr().String()
	if err := lis.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	p := planFor(t, target, 1, 1, 0, []string{"true"})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := drive(ctx, p); err == nil {
		t.Fatal("drive accepted a target nothing is listening on")
	}
}

// An unwritable times file is a setup failure too, for the same reason.
func TestDriveFailsWhenASlotsTimesFileCannotBeCreated(t *testing.T) {
	f := &fakeExec{}
	p := planFor(t, startFake(t, f), 1, 1, 0, []string{"true"})
	p.Slots[0].TimesFile = filepath.Join(p.Slots[0].TimesFile, "no", "such", "dir", "slot-1.times")
	if err := drive(context.Background(), p); err == nil {
		t.Fatal("drive accepted a slot whose times file cannot be created")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd remote-worker && go test ./cmd/exec-driver/ -run TestDrive -v
```

Expected: FAIL — `undefined: drive`.

- [ ] **Step 3: Write `drive.go`**

Create `remote-worker/cmd/exec-driver/drive.go`:

```go
package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/connectivity"
	"google.golang.org/grpc/credentials/insecure"

	pb "github.com/kagenti/serverless-harness/gen/go/sandbox/v1"
)

// dialReady returns a connection that is already READY.
//
// This is the whole point of the binary (#294): grpcurl opened a fresh TCP connection and
// HTTP/2 session per Exec, and that cost sat inside every measured latency. Bringing the
// connection up BEFORE any slot starts means the first Exec of the rung pays no more than the
// last one does.
func dialReady(ctx context.Context, target string) (*grpc.ClientConn, error) {
	cc, err := grpc.NewClient(target, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, fmt.Errorf("creating a client for %s: %w", target, err)
	}
	cc.Connect()
	for {
		s := cc.GetState()
		if s == connectivity.Ready {
			return cc, nil
		}
		if !cc.WaitForStateChange(ctx, s) {
			_ = cc.Close()
			return nil, fmt.Errorf("connection to %s never reached READY (last state %s): refusing to time Execs over a connection that is not up, because every one of them would record a client-side error as a latency: %w", target, s, ctx.Err())
		}
	}
}

// execOutcome is one line of a times file, before it is formatted. errMsg is kept separately
// from cause so the operator gets the original text in the slot's err file while the record
// gets the classified key.
type execOutcome struct {
	ms     int64
	status string
	cause  string
	errMsg string
}

func (o execOutcome) line() string { return fmt.Sprintf("%d %s %s", o.ms, o.status, o.cause) }

// oneExec issues a single Exec and times it host-side, which is what grpc_exec_record does
// with $EPOCHREALTIME either side of its grpcurl call.
//
// The stream is drained to io.EOF rather than stopped at End, because grpcurl drains it:
// returning early would shorten the measured latency for a reason that has nothing to do
// with the change being measured.
//
// An in-stream ExecEvent.error is a FAILED Exec. The relay
// (packages/sandbox-relay/src/relay.ts routeExec) yields that event and then returns a gRPC
// OK status, so grpcurl exits 0 and the bash path records it as ok -- counting a failed Exec
// toward throughput and into the p95 distribution. The null-responder never sends one, so
// being correct here costs the driver-control comparison nothing.
func oneExec(ctx context.Context, client pb.SandboxExecClient, p *plan, s slot, reqID uint64, cmd string) execOutcome {
	callCtx, cancel := context.WithTimeout(ctx, time.Duration(p.CallDeadlineS)*time.Second)
	defer cancel()

	t0 := time.Now()
	fail := func(msg string) execOutcome {
		return execOutcome{ms: time.Since(t0).Milliseconds(), status: "err", cause: causeFor(msg), errMsg: msg}
	}

	stream, err := client.Exec(callCtx, &pb.ExecRequest{
		SandboxId: p.SandboxID,
		Exec: &pb.Exec{
			ReqId:        reqID,
			Command:      cmd,
			TimeoutS:     p.ExecTimeoutS,
			WorkspaceKey: s.WorkspaceKey,
		},
	})
	if err != nil {
		return fail(err.Error())
	}

	var inStream string
	for {
		ev, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fail(err.Error())
		}
		if e := ev.GetError(); e != nil && inStream == "" {
			inStream = e.GetMessage()
		}
	}
	ms := time.Since(t0).Milliseconds()
	if inStream != "" {
		return execOutcome{ms: ms, status: "err", cause: causeFor(inStream), errMsg: inStream}
	}
	return execOutcome{ms: ms, status: "ok", cause: "-"}
}

// runSlot is one slot's whole timed loop: the goroutine that replaces one bash subshell.
//
// Writes are BUFFERED and flushed once at the end. The alternative -- a write syscall per
// Exec -- is driver cost inside the measured window, which is the thing being removed. A rung
// killed mid-flight loses its tail, and that is fine: run_density_rung refuses a rung whose
// child exited non-zero rather than recording a partial one.
func runSlot(ctx context.Context, client pb.SandboxExecClient, p *plan, s slot) error {
	times, err := os.OpenFile(s.TimesFile, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return fmt.Errorf("opening times file %s: %w", s.TimesFile, err)
	}
	defer func() { _ = times.Close() }()
	errFile, err := os.OpenFile(s.ErrFile, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return fmt.Errorf("opening err file %s: %w", s.ErrFile, err)
	}
	defer func() { _ = errFile.Close() }()

	w := bufio.NewWriter(times)
	calls := p.callsPerSlot()
	for i := 0; i < calls; i++ {
		// reqBase itself is converge's, so Execs start one past it -- the same arithmetic
		// run_density_rung does with `req=$req_base` then `req=$((req + 1))` before each call.
		o := oneExec(ctx, client, p, s, s.ReqBase+1+uint64(i), p.Mix[i%len(p.Mix)])
		if _, err := fmt.Fprintln(w, o.line()); err != nil {
			return fmt.Errorf("writing to times file %s: %w", s.TimesFile, err)
		}
		if o.errMsg != "" {
			// Best effort: losing the diagnostic text must not fail a rung whose timings are fine.
			_, _ = fmt.Fprintf(errFile, "req %d: %s\n", s.ReqBase+1+uint64(i), o.errMsg)
		}
	}
	if err := w.Flush(); err != nil {
		return fmt.Errorf("flushing times file %s: %w", s.TimesFile, err)
	}
	return nil
}

// drive runs one whole rung: one connection, one goroutine per slot.
//
// ONE ClientConn for every slot is the change #294 asks for. Its known bound is not a
// concurrent-stream cap -- neither server caps streams by default on the pinned versions --
// but that a single connection has one loopyWriter goroutine and one connection-level
// flow-control window, so all c slots' framing serializes through one writer. Nothing has
// measured that binding; if the Go client's throughput plateaus while coresBusy stays low,
// sharding slots across N connections is the first thing to try.
func drive(ctx context.Context, p *plan) error {
	cc, err := dialReady(ctx, p.Target)
	if err != nil {
		return err
	}
	defer func() { _ = cc.Close() }()
	client := pb.NewSandboxExecClient(cc)

	errs := make([]error, len(p.Slots))
	var wg sync.WaitGroup
	for i, s := range p.Slots {
		wg.Add(1)
		// Go 1.22+ gives each iteration its own i and s, so the closure captures this slot.
		go func() {
			defer wg.Done()
			errs[i] = runSlot(ctx, client, p, s)
		}()
	}
	wg.Wait()

	for i, e := range errs {
		if e != nil {
			return fmt.Errorf("slot %d (reqBase %d): %w", i+1, p.Slots[i].ReqBase, e)
		}
	}
	return nil
}
```

- [ ] **Step 4: Write `main.go`**

Create `remote-worker/cmd/exec-driver/main.go`:

```go
// Command exec-driver is E11's persistent-connection Exec client (issue #294).
//
// It replaces the ONE remaining per-Exec process spawn in deploy/microvm/e11-density.sh's
// timed window. PR #293 removed the other ~8 spawns per Exec (two of them Python
// interpreters); what was left was one execve of grpcurl, which re-parses the proto
// descriptor set and opens a fresh TCP connection and HTTP/2 session before sending a single
// request. Measured on metal with the driver-control arm -- no relay, no Redis, no worker, no
// VMM -- that driver alone peaked at c=8 and then declined, burning 64 of 72 cores at c=64
// with its own p95 of 753ms against the published microVM arm's 1686ms. The published knee
// was the driver's.
//
// This binary is ONE process for a whole rung: one grpc.ClientConn reused across every Exec,
// and c goroutines in place of c bash subshells. It writes the same per-slot
// "<ms> <status> <cause>" lines grpc_exec_record wrote, so run_density_rung's aggregation,
// percentiles and record writer are untouched.
//
// It is opt-in behind SH_E11_EXEC_CLIENT=go so the bash path stays the reference until the
// two are compared on one host (#294's acceptance criterion).
//
// Built against the existing gen/go/sandbox/v1 stubs, like cmd/null-responder. No new codegen.
package main

import (
	"context"
	"flag"
	"log"
)

func main() {
	planPath := flag.String("plan", "", "path to the rung plan JSON written by e11-density.sh's write_rung_plan")
	flag.Parse()

	if *planPath == "" {
		log.Fatalf("exec-driver: --plan is required: without a rung plan there is no target, no mix and no slot identity, so there is nothing to time")
	}
	p, err := loadPlan(*planPath)
	if err != nil {
		log.Fatalf("exec-driver: %v", err)
	}
	// No overall deadline. The per-call deadline in the plan (callDeadlineS, from
	// SH_E11_EXEC_MAX_TIME_S) is the guard against a wedged Exec, exactly as grpcurl's
	// -max-time was; a rung-level timeout would additionally cap legitimate slow rungs at
	// high c, which is the regime being measured.
	if err := drive(context.Background(), p); err != nil {
		log.Fatalf("exec-driver: %v", err)
	}
}
```

- [ ] **Step 5: Run the whole package's tests and build the binary**

```bash
cd remote-worker && gofmt -l ./cmd/exec-driver/ && go vet ./cmd/exec-driver/ && go test ./cmd/exec-driver/ -v 2>&1 | tail -40 && go build -o /tmp/exec-driver ./cmd/exec-driver && /tmp/exec-driver 2>&1; echo "EXIT:$?"
```

Expected: `gofmt -l` prints nothing, `go vet` is silent, every test PASSES, the build succeeds, and running with no `--plan` prints the `--plan is required` message and exits 1.

- [ ] **Step 6: Prove the connection is reused, not re-dialled**

One connection per rung is the claim the whole issue rests on, so observe it rather than trust it. Start the real `null-responder`, point a 1-slot 200-iteration plan at it, and count established sockets on its port while the rung runs.

```bash
cd remote-worker && go build -o /tmp/null-responder ./cmd/null-responder && go build -o /tmp/exec-driver ./cmd/exec-driver
/tmp/null-responder --listen 127.0.0.1:8447 >/tmp/nr-reuse.log 2>&1 &
NR_PID=$!
sleep 1
mkdir -p /tmp/e11-reuse && python3 - <<'PLANJSON'
import json
p = {"target": "localhost:8447", "sandboxId": "e11-driver-control", "itersPerSlot": 200,
     "warmupPerSlot": 0, "execTimeoutS": 30, "callDeadlineS": 45, "mix": ["true"],
     "slots": [{"reqBase": 1000000, "workspaceKey": "",
                "timesFile": "/tmp/e11-reuse/slot-1.times", "errFile": "/tmp/e11-reuse/slot-1.err"}]}
open("/tmp/e11-reuse/plan.json", "w").write(json.dumps(p))
PLANJSON
/tmp/exec-driver --plan /tmp/e11-reuse/plan.json &
DRV_PID=$!
sleep 1; netstat -an | grep -c '8447.*ESTABLISHED'
# Wait on the DRIVER only. A bare `wait` would also wait on the null-responder, which never
# exits on its own, so the command would hang.
wait "$DRV_PID"; wc -l /tmp/e11-reuse/slot-1.times; kill "$NR_PID"
```

Expected: the ESTABLISHED count is **2** (one socket, counted from both ends on loopback) while 200 Execs are in flight — not 200 and not climbing. `slot-1.times` has 200 lines.

- [ ] **Step 7: Commit**

```bash
git add remote-worker/cmd/exec-driver/drive.go remote-worker/cmd/exec-driver/main.go remote-worker/cmd/exec-driver/drive_test.go
git commit -s -m "feat(e11): exec-driver, one connection and c goroutines per rung (#294)

The connection is brought to READY before any slot starts, so the first
Exec of a rung pays no more than the last: grpcurl's per-call TCP and
HTTP/2 setup was inside every measured latency.

Streams are drained to io.EOF rather than stopped at End, because grpcurl
drains them. An in-stream ExecEvent.error is recorded as a FAILED Exec:
the relay yields it and then returns a gRPC OK status, so grpcurl exits 0
and the bash path counts a failed Exec toward throughput. The
null-responder never sends one, so being right here costs the
driver-control comparison nothing.

Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

### Task 4: Select the client, and build it

**Files:**

- Modify: `deploy/microvm/e11-density.sh` — add `EXEC_CLIENT` / `E11_EXEC_DRIVER_BIN` near the other env knobs (after `EXEC_MAX_TIME_S`, around line 305); add `validate_exec_client` beside `validate_arms` (around line 425); call it from `preflight` (line 455, right after `validate_arms`); add `build_exec_driver` beside `start_null_stack` (around line 1450); call it from `main` after `preflight` (line 1949).
- Test: `deploy/microvm/tests/e11-density.test.sh` — new section.

**Interfaces:**

- Consumes: `die`, `log`, `require_tool`, `REMOTE_WORKER_DIR`, `RESULTS` (all existing).
- Produces: `EXEC_CLIENT` (`grpcurl`|`go`), `E11_EXEC_DRIVER_BIN`, `validate_exec_client()`, `build_exec_driver()`. Tasks 5–9 read `EXEC_CLIENT` and `E11_EXEC_DRIVER_BIN`.

`preflight` already ends with `mkdir -p "$RESULTS"`, and `main` calls `preflight` first, so `build_exec_driver` placed after `preflight` in `main` can write into `$RESULTS`. `go` is already an unconditional `require_tool`, so no new requirement is needed. `grpcurl` stays unconditional too, because converge uses it on every arm regardless of this setting.

- [ ] **Step 1: Write the failing test**

Append to `deploy/microvm/tests/e11-density.test.sh`, before its final `echo "Total failures: $fails"` block:

```bash
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
out="$(
  EXEC_CLIENT="grpcurl-go"
  eval "$vec_body"
  die() {
    echo "DIED: $*"
    exit 1
  }
  validate_exec_client && echo ACCEPTED
)"
check "validate_exec_client refuses an unrecognised value" \
  "$(printf '%s' "$out" | grep -c '^DIED:')" "1"
check "  ...and its refusal names both accepted values" \
  "$(printf '%s' "$out" | grep -c "grpcurl.*go\|go.*grpcurl")" "1"

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
check "main builds the Exec driver after preflight" \
  "$(printf '%s\n' "$(extract_fn main)" | grep -c 'build_exec_driver')" "1"

# The binary lives under $RESULTS, like the null-responder's, so a run leaves its artifacts
# in one place and preflight's own `mkdir -p "$RESULTS"` has already happened.
check "the exec-driver binary path is under \$RESULTS" \
  "$(grep -c 'E11_EXEC_DRIVER_BIN="\$RESULTS/.e11-exec-driver-bin"' "$SCRIPT")" "1"
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bash deploy/microvm/tests/e11-density.test.sh 2>&1 | grep -A2 'the Exec client is selectable'
```

Expected: FAIL on every check — `validate_exec_client` and `build_exec_driver` do not exist yet.

- [ ] **Step 3: Add the two settings**

In `deploy/microvm/e11-density.sh`, immediately after the `CONVERGE_MAX_TIME_S` line (~line 306), insert:

```bash
# SH_E11_EXEC_CLIENT selects WHICH CLIENT issues the timed Execs (issue #294).
#
#   grpcurl - one grpcurl process per Exec. The reference path, and the default.
#   go      - remote-worker/cmd/exec-driver: one process and ONE grpc.ClientConn for a whole
#             rung, c goroutines in place of c subshells.
#
# Why this is opt-in rather than a replacement: measured on metal with the driver-control arm
# (no relay, no Redis, no worker, no VMM), the grpcurl driver ALONE peaked at c=8 and then
# declined, burning 64 of 72 cores at c=64 with its own p95 of 753ms -- the same knee position
# and curve shape EXPERIMENTS.md published for both real arms. The Go client exists to remove
# that, but the number that proves it must come from running BOTH against the null-responder on
# one host with nothing else changed. Until that comparison exists, the bash path is the
# reference and stays the default.
EXEC_CLIENT="${SH_E11_EXEC_CLIENT:-grpcurl}"
# Built once per run by build_exec_driver, beside the null-responder's binary.
E11_EXEC_DRIVER_BIN="$RESULTS/.e11-exec-driver-bin"
```

- [ ] **Step 4: Add `validate_exec_client`**

Immediately after `validate_arms`'s closing brace (~line 425), insert:

```bash
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
```

- [ ] **Step 5: Call it from `preflight`**

In `preflight`, on the line after `validate_arms` (~line 455), add:

```bash
  # Before anything that depends on the value: build_exec_driver in main() reads it, and the
  # record writer stamps it.
  validate_exec_client
```

- [ ] **Step 6: Add `build_exec_driver`**

Immediately after `stop_null_stack`'s closing brace (~line 1450), insert:

```bash
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
```

- [ ] **Step 7: Call it from `main`**

In `main`, immediately after `preflight` (line 1949), add:

```bash
  # After preflight, which validated EXEC_CLIENT and created $RESULTS.
  build_exec_driver
```

- [ ] **Step 8: Run the tests and shellcheck**

```bash
shellcheck -x -S warning deploy/microvm/e11-density.sh; echo "SHELLCHECK:$?"
bash deploy/microvm/tests/e11-density.test.sh 2>&1 | tail -5
```

Expected: `SHELLCHECK:0`, and `Total failures: 0`.

- [ ] **Step 9: Commit**

```bash
git add deploy/microvm/e11-density.sh deploy/microvm/tests/e11-density.test.sh
git commit -s -m "feat(e11): SH_E11_EXEC_CLIENT selects the Exec client, grpcurl by default (#294)

Opt-in, because #294's acceptance is a comparison: the bash path has to
stay the reference until both have run against the null-responder on one
host with nothing else changed. An unrecognised value is refused rather
than defaulted, since the value is stamped into every rung as execClient
and a mislabelled ladder gets compared against the wrong table.

build_exec_driver is a no-op unless the Go client was selected, so a
grpcurl run cannot fail over a binary it never invokes.

Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

### Task 5: Write the rung plan

**Files:**

- Modify: `deploy/microvm/e11-density.sh` — add `write_rung_plan` after `escaped_mix` (~line 1083, before `grpc_exec_record`); extend the pre-escape loop in `run_density_rung` (lines 1524–1537) with a raw workspace-key array and the plan call.
- Test: `deploy/microvm/tests/e11-density.test.sh` — new section.

**Interfaces:**

- Consumes: `slot_req_base`, `slot_run_id`, `slot_workspace_key`, `e11_tool_call_mix`, `json_escape`, `EXEC_MAX_TIME_S`, `ITERS_PER_SLOT`, `WARMUP_PER_SLOT` (all existing).
- Produces:
  - `write_rung_plan <out_path> <target> <sandbox_id> <iters> <warmup> <exec_timeout_s> <deadline_s> <mix_count> <slot_count> <mix...> <slot_fields...>` where `slot_fields` is 4 entries per slot in order `reqBase workspaceKey timesFile errFile`. A pure function of its arguments — no globals read — so the suite can drive it in isolation, matching `static_settings_json`'s stated pattern.
  - `ws_raw_by_slot` and `plan_file` locals in `run_density_rung`. Task 6 reads `plan_file`.

Everything goes through **argv**, not a delimited file: bash passes each array element as one argv entry, so a workspace key or a path containing a space, quote or tab cannot be mis-split. `python3`'s `json.dumps` then does every escape, which is where the existing driver already puts JSON escaping.

The mix and the slot fields are appended after a count of each, so the function stays positional and pure rather than reaching for caller arrays by name.

- [ ] **Step 1: Write the failing test**

Append to `deploy/microvm/tests/e11-density.test.sh`:

```bash
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bash deploy/microvm/tests/e11-density.test.sh 2>&1 | grep -A3 'write_rung_plan emits a plan'
```

Expected: FAIL — `write_rung_plan` is not extractable.

- [ ] **Step 3: Add `write_rung_plan`**

In `deploy/microvm/e11-density.sh`, immediately after `escaped_mix`'s closing brace (~line 1083), insert:

```bash
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
```

- [ ] **Step 4: Derive the raw workspace keys once, and write the plan**

Replace lines 1524–1537 of `deploy/microvm/e11-density.sh` (the `mix_json` / `ws_json_by_slot` block) with:

```bash
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
  # timed window (issue #294, and the fork guard in tests/e11-density.test.sh asserts it).
  local plan_file="$E11_TMPDIR/plan-$rung_tag.json"
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
  fi
```

- [ ] **Step 5: Run the tests and shellcheck**

```bash
shellcheck -x -S warning deploy/microvm/e11-density.sh; echo "SHELLCHECK:$?"
bash deploy/microvm/tests/e11-density.test.sh 2>&1 | tail -5
```

Expected: `SHELLCHECK:0` and `Total failures: 0`. If shellcheck flags SC2034 on `plan_file` (assigned but unused until Task 6), leave the code as written and fix it in Task 6 rather than adding a suppression that would then be stale — but if the suite fails, note it and continue to Task 6, which consumes the variable.

- [ ] **Step 6: Prove a real plan is loadable by the real binary**

```bash
cd remote-worker && go build -o /tmp/exec-driver ./cmd/exec-driver && cd ..
PLAN=/tmp/e11-real-plan.json
bash -c '
  eval "$(sed -n "/^slot_req_base() {/,/^}/p;/^write_rung_plan() {/,/^}/p;/^die() {/,/^}/p;/^e11_tool_call_mix() {/,/^}/p" deploy/microvm/e11-density.sh)"
  argv=(); while IFS= read -r c; do argv+=("$c"); done < <(e11_tool_call_mix)
  for i in 1 2; do argv+=("$(slot_req_base "$i")" "" "/tmp/e11-real/slot-$i.times" "/tmp/e11-real/slot-$i.err"); done
  mkdir -p /tmp/e11-real
  write_rung_plan '"$PLAN"' "localhost:8448" "e11-driver-control" 5 2 30 45 7 2 "${argv[@]}"
'
python3 -m json.tool $PLAN | head -20
/tmp/exec-driver --plan $PLAN 2>&1; echo "EXIT:$?"
```

Expected: the plan pretty-prints with all 7 mix commands and 2 slots, and `exec-driver` exits **non-zero** with a message about the connection to `localhost:8448` never reaching READY — i.e. it parsed and validated the real plan and failed only because nothing is listening. Validation failures would say so instead, and that would be a real defect.

- [ ] **Step 7: Commit**

```bash
git add deploy/microvm/e11-density.sh deploy/microvm/tests/e11-density.test.sh
git commit -s -m "feat(e11): write_rung_plan, the bash-to-Go boundary (#294)

Everything travels through argv and json.dumps does every escape: bash
passes each array element as one argv entry, so a workspace key or path
containing a quote, backslash or tab cannot be mis-split, and JSON
escaping stays in the one place this driver already puts it.

slot_workspace_key is called once per slot and feeds both the pre-escaped
form the grpcurl path interpolates and the raw form the plan carries.
Deriving it twice is how the two clients would drift into sending
different keys.

Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

### Task 6: Branch phase 2

**Files:**

- Modify: `deploy/microvm/e11-density.sh` — the phase-2 block, lines 1554–1595 (`pids=()` through the `exec_failures` refusal).
- Modify: `deploy/microvm/tests/e11-density.test.sh` — extend the existing fork guard at line 845 and add a branch section.

**Interfaces:**

- Consumes: `EXEC_CLIENT`, `E11_EXEC_DRIVER_BIN` (Task 4); `plan_file` (Task 5).
- Produces: nothing new. This task is where the two paths meet, and the `grpcurl` branch must come out byte-identical to what went in.

Two details that are easy to get wrong:

1. **The `wait` shape stays.** The Go path pushes one pid onto the same `pids` array the subshell loop used, so the existing `for pid in "${pids[@]}"; do wait ...` and the refusal below it keep working unchanged.
2. **The refusal message must not lie.** `exec_failures` of 1 on the Go path means _one process_ failed, not "1 of 8 slots" — the Go child drives all `c` slots, so a non-zero exit invalidates the whole rung. The message branches; the guarantee does not.

- [ ] **Step 1: Extend the fork guard, and write the branch test**

In `deploy/microvm/tests/e11-density.test.sh`, change the `tw_detect` definition at line 869 from:

```bash
tw_detect() { printf '%s\n' "$1" | grep -cE '\bjson_escape\b|date \+%s%N|\bmktemp\b|\bwc -l\b'; }
```

to:

```bash
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
```

and add one non-vacuousness check beside the existing four (after the `wc -l` one at line 878):

```bash
check "non-vacuousness: the detector flags a literal python3 in the window" \
  "$(tw_detect '  python3 -c "import json"')" "1"
check "scope: the detector does NOT see python3 through a write_rung_plan call" \
  "$(tw_detect '  write_rung_plan "$plan_file" "localhost:8445" "$sandbox_id"')" "0"
```

Then append a new section to the file:

```bash
# ---------------------------------------------------------------------------
# The phase-2 branch (issue #294)
# ---------------------------------------------------------------------------
echo "== phase 2 runs ONE exec-driver process on the Go path and c subshells on the grpcurl path (#294)"

rdr_body="$(extract_fn run_density_rung || true)"
check "run_density_rung is extractable" "$([ -n "$rdr_body" ] && echo yes || echo no)" "yes"

# The window body, extracted exactly as the fork guard above does it.
win="$(printf '%s\n' "$rdr_body" | awk '/wall_t0="/{f=1; next} /wall_t1="/{exit} f{print}' | grep -v '^[[:space:]]*#')"
check "the Go path runs the exec-driver binary inside the timed window" \
  "$(printf '%s\n' "$win" | grep -c '"\$E11_EXEC_DRIVER_BIN" --plan "\$plan_file"')" "1"
check "  ...exactly once, not once per slot" \
  "$(printf '%s\n' "$win" | grep -c 'for ((i = 1; i <= c; i++))')" "1"
check "  ...and the grpcurl subshell loop is still there, unchanged" \
  "$(printf '%s\n' "$win" | grep -c 'grpc_exec_record "\$relay_port"')" "1"
check "  ...selected by EXEC_CLIENT, not by arm" \
  "$(printf '%s\n' "$win" | grep -c 'if \[ "\$EXEC_CLIENT" = "go" \]')" "1"
# write_rung_plan must NOT be in the window: Task 5 put it before wall_t0 and the fork guard
# above now flags python3, but assert the call site directly too, because that guard would also
# pass if the call vanished entirely.
check "write_rung_plan is called OUTSIDE the timed window" \
  "$(printf '%s\n' "$win" | grep -c 'write_rung_plan')" "0"
check "  ...and is called somewhere in run_density_rung" \
  "$(printf '%s\n' "$rdr_body" | grep -c 'write_rung_plan "\$plan_file"')" "1"

# The refusal must not claim "1 of c slots" when one process drove all c of them.
check "the Go path's refusal says the whole rung is invalid, not one slot" \
  "$(printf '%s\n' "$rdr_body" | grep -c 'the Go exec-driver exited non-zero')" "1"
check "  ...and the grpcurl path keeps its per-slot refusal" \
  "$(printf '%s\n' "$rdr_body" | grep -c 'slot(s) fail inside the timed loop')" "1"

# Both paths still go through the SAME wait-and-refuse shape, which is what makes "a rung whose
# slots were not all measuring the same thing is never recorded" true for both.
check "both paths are waited on through the same pids array" \
  "$(printf '%s\n' "$rdr_body" | grep -c 'wait "\$pid" || exec_failures=\$((exec_failures + 1))')" "1"

# Converge stays on grpcurl on BOTH paths -- a stated non-goal. It is already outside the timed
# window and reported separately as convergeMsP50, so routing it through the new client would
# move a number this work is not measuring, inside the same PR that moves the one it is.
cs_body="$(extract_fn converge_slot || true)"
check "converge_slot is extractable" "$([ -n "$cs_body" ] && echo yes || echo no)" "yes"
check "converge still drives grpcurl, on every path" \
  "$(printf '%s\n' "$cs_body" | grep -c 'grpcurl -plaintext')" "1"
check "  ...and converge is not routed through EXEC_CLIENT at all" \
  "$(printf '%s\n' "$cs_body" | grep -c 'EXEC_CLIENT')" "0"
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bash deploy/microvm/tests/e11-density.test.sh 2>&1 | grep -A4 'phase 2 runs ONE exec-driver'
```

Expected: FAIL on the Go-path checks; the `grpcurl` ones already pass.

- [ ] **Step 3: Branch phase 2**

Replace `deploy/microvm/e11-density.sh` lines 1554–1595 — from `  pids=()` down to and including the `exec_failures` refusal — with:

```bash
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
```

- [ ] **Step 4: Confirm the `grpcurl` branch came out byte-identical**

```bash
git diff -U0 deploy/microvm/e11-density.sh | grep '^-' | grep -v '^---' | grep -vE 'pids=\(\)|local exec_failures|for pid in|wait "\$pid"|wall_t1=|sampler_stop|E11_SAMPLER_PID|\[ "\$exec_failures" -eq 0 \]|die "rung arm=\$arm d=\$d ram=\$\{ram_mb\}MiB c=\$c had|for \(\(i = 1|\) &|done$'
```

Expected: **no output.** Every removed line is either one of the control-flow lines being re-indented into the branch or the old refusal. If a line from the subshell body appears, it was altered — restore it from `git show HEAD:deploy/microvm/e11-density.sh`.

- [ ] **Step 5: Run the tests and shellcheck**

```bash
shellcheck -x -S warning deploy/microvm/e11-density.sh; echo "SHELLCHECK:$?"
bash deploy/microvm/tests/e11-density.test.sh 2>&1 | tail -5
```

Expected: `SHELLCHECK:0` and `Total failures: 0`.

- [ ] **Step 6: Commit**

```bash
git add deploy/microvm/e11-density.sh deploy/microvm/tests/e11-density.test.sh
git commit -s -m "feat(e11): run one exec-driver process per rung on the Go path (#294)

Both branches push onto the same pids array and are reaped by the same
wait loop, so the guarantee that a rung whose slots were not all
measuring the same thing is never recorded holds identically for both.

The refusal branches because the failure differs: one Go process drives
all c slots, so a non-zero exit means the rung has no trustworthy
timings at all, and reporting it as 1 of c slots would understate it.

The fork guard now also flags python3 between the wall stamps, so a
future edit cannot move write_rung_plan into the timed window.

Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

### Task 7: Record which client produced the rung

**Files:**

- Modify: `deploy/microvm/e11-density.sh` — the record writer (`python3 -c` block at line 1799); `proxyLimitations` (lines 1854–1860).
- Modify: `experiments/src/microvm-density.ts` — `RungSample`, after `samplingMode?` (~line 122).
- Test: `deploy/microvm/tests/e11-density.test.sh` — the existing record-writer section (`extract_record_writer`, line 528).
- Test: `experiments/test/microvm-density.test.ts`.

**Interfaces:**

- Consumes: `EXEC_CLIENT` (Task 4).
- Produces: `execClient` in every rung record, values `grpcurl-per-exec` | `go-persistent-conn`; `execClient?: string` on `RungSample`.

Why it must exist: without it, two ladders cannot be told apart. That is the same class of defect `c953c98` fixed one level down — a ladder that looks complete while mixing measurements that were never comparable. `samplingMode` is the precedent for a recorded provenance marker nothing scores.

`drivingModel` is **not** in `RungSample` today, but `samplingMode` is, and `execClient` is the same kind of field: recorded provenance, read by no scorer, present so a mean can be attributed. It goes in.

- [ ] **Step 1: Write the failing tests**

In `deploy/microvm/tests/e11-density.test.sh`, extend the record-writer section (line 524, `== the rung-record writer, executed with real container-arm inputs`).

**First**, add the three variables the new interpolations read into `run_writer`'s subshell, after its `E11_RUN_ID=RUN-FIXTURE` line (~line 572). The extracted writer runs under `set -u`, so an undefined interpolation aborts it — and that abort would look exactly like the pre-fix `SyntaxError` the section's non-vacuousness check asserts, so leaving them out breaks the section in a confusing way:

```bash
      # #294's interpolations. The label is what the checks below assert; the two notes stand
      # in for the long disclosure strings, whose presence (not text) is what matters here.
      exec_client_json=grpcurl-per-exec
      driver_control_note='driver-control is a STRICT LOWER BOUND on driver-only cost'
      exec_error_note='an in-stream ExecEvent.error is recorded as status=ok'
```

**Then** add these checks beside the existing `samplingMode` assertion (~line 629). They read `$ok_out`, the record the section already writes:

```bash
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
```

Then add a small section asserting the label mapping is exhaustive:

```bash
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
```

In `experiments/test/microvm-density.test.ts`, add:

```ts
it('accepts a rung record carrying execClient, and older records without it', () => {
  const withClient: RungSample = {
    c: 8,
    throughput: 241.6,
    p95Ms: 44,
    coldAcquireRate: 0,
    pssBytes: 0,
    memAvailableBytes: 808960000000,
    hostCpuFraction: 0.2017,
    processCount: 0,
    standbysResident: 0,
    idleStandbyResidency: 0,
    leaseSaturations: 0,
    execErrorsByCause: {},
    execClient: 'go-persistent-conn',
  };
  expect(withClient.execClient).toBe('go-persistent-conn');

  // The field is optional because every record written before #294 lacks it, and nothing
  // scores it -- it exists so a ladder's numbers can be attributed to the client that
  // produced them.
  const { execClient: _dropped, ...withoutClient } = withClient;
  expect((withoutClient as RungSample).execClient).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bash deploy/microvm/tests/e11-density.test.sh 2>&1 | grep -E 'execClient|execErrorStatus|exec_client_label'
```

Expected: FAIL — `KeyError: 'execClient'`, `False` for `execErrorStatus`, and `exec_client_label` not extractable.

- [ ] **Step 3: Add `exec_client_label`**

In `deploy/microvm/e11-density.sh`, immediately after `validate_exec_client`'s closing brace, insert:

```bash
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
```

- [ ] **Step 4: Add the field and the disclosure to the record writer**

In `run_density_rung`, just above the `python3 -c "` record writer (line 1799), add:

```bash
  # Interpolated as python literals below, so they are computed here rather than inline.
  local exec_client_json driver_control_note exec_error_note
  exec_client_json="$(exec_client_label)"
  # The two proxyLimitations entries that DEPEND on which client ran. Both are written on both
  # paths -- a limitation that only appears on the path that does not have it is not a
  # disclosure. Neither string may contain an apostrophe: they are interpolated into
  # single-quoted python literals.
  if [ "$EXEC_CLIENT" = "go" ]; then
    driver_control_note="driver-control remains a lower bound on driver-only cost, but a tighter one than on the grpcurl path: the Go client decodes the same ExecEvent stream on every arm, so the only residual difference is that the null-responder sends one End and no Chunk, while real Execs for mix commands producing stdout decode one or more Chunk events per call (#294)."
    exec_error_note="an in-stream ExecEvent.error is recorded as status=err with its cause classified from the message. The grpcurl path records it as ok, because the relay yields that event and then returns a gRPC OK status. The two clients therefore DISAGREE on throughput, p95 and execErrorsByCause for any rung that produced ExecErrors on the container or microvm arms; they agree exactly on driver-control, where the null-responder never sends one (#294)."
  else
    driver_control_note="driver-control is a STRICT LOWER BOUND on driver-only cost, not an exact one: the null-responder sends one End and no Chunk events, so grpcurl never decodes a chunk-carrying stream on this arm, while real Execs for mix commands that produce stdout do decode one or more Chunk events per call on the container/microvm arms. Subtracting driver-control latency therefore over-attributes some residue to the backend rather than the driver (#291 item 3)."
    exec_error_note="an in-stream ExecEvent.error is recorded as status=ok. The relay yields that event and then returns a gRPC OK status, so grpcurl exits 0: an ExecError-failed Exec counts toward throughput, enters the distribution p95 is taken over, and never reaches execErrorsByCause. Pre-existing on this path and fixed on the go path (#294)."
  fi
```

Then in the record dict, replace the `drivingModel` line and the `driverControlChunkDecode` entry:

```python
  'drivingModel': 'closed-loop-per-slot',
  # WHICH CLIENT issued the Execs these latencies came from (#294). Without it a go-driven
  # ladder and a grpcurl-driven one are indistinguishable JSON, and comparing them is the
  # entire reason the second client exists.
  'execClient': '$exec_client_json',
```

and inside `proxyLimitations`:

```python
    'driverControlChunkDecode': '$driver_control_note',
    'execErrorStatus': '$exec_error_note',
```

- [ ] **Step 5: Add the TypeScript field**

In `experiments/src/microvm-density.ts`, immediately after the `samplingMode?: string;` declaration and its comment (~line 122), add:

```ts
  /**
   * Which client issued this rung's Execs: `"grpcurl-per-exec"` (one process per call, the
   * reference path) or `"go-persistent-conn"` (remote-worker/cmd/exec-driver, one connection
   * per rung). Absent on records written before issue #294. NOTHING here scores it -- like
   * `samplingMode`, it exists so a ladder's numbers can be attributed rather than merely
   * compared, because the driver's own cost was 753ms of the published microVM arm's 1686ms
   * p95 at c=64.
   */
  execClient?: string;
```

- [ ] **Step 6: Run the tests**

```bash
shellcheck -x -S warning deploy/microvm/e11-density.sh; echo "SHELLCHECK:$?"
bash deploy/microvm/tests/e11-density.test.sh 2>&1 | tail -5
cd experiments && ../node_modules/.bin/vitest run test/microvm-density.test.ts 2>&1 | tail -15
```

Expected: `SHELLCHECK:0`; `Total failures: 0`; the vitest file passes.

This worktree has no `node_modules` and its `pi-fork` submodule is empty, so `experiments`' vitest may not run here. If it does not: **never** fall back to `npx vitest` — that resolves vitest 4 instead of the pinned 2.1.9 and invents failures. Instead run the single file from the main checkout using its `node_modules/.bin/vitest`, or record the TS check as deferred in the task report and say so explicitly rather than claiming it passed.

- [ ] **Step 7: Format and commit**

```bash
PRETTIER=/Users/paolo/Projects/aiplatform/serverless-harness/node_modules/.bin/prettier
"$PRETTIER" --write experiments/src/microvm-density.ts experiments/test/microvm-density.test.ts
"$PRETTIER" --check experiments/src/microvm-density.ts experiments/test/microvm-density.test.ts
git add deploy/microvm/e11-density.sh deploy/microvm/tests/e11-density.test.sh experiments/src/microvm-density.ts experiments/test/microvm-density.test.ts
git commit -s -m "feat(e11): record execClient on every rung (#294)

Without it a go-driven ladder and a grpcurl-driven one are
indistinguishable JSON, and comparing them is the entire reason the second
client exists. Same class of defect c953c98 fixed for stale rungs, one
level up.

proxyLimitations gains execErrorStatus on BOTH paths: a limitation that
appears only on the path that does not have it is not a disclosure. On
grpcurl it records that an ExecError-failed Exec counts as a success; on
go, that it does not, and that the two therefore disagree on the real arms
while agreeing exactly on driver-control.

Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

### Task 8: Close the seam end to end

**Files:**

- Test: `deploy/microvm/tests/e11-density.test.sh` — new section.

**Interfaces:**

- Consumes: `write_rung_plan`, `slot_req_base`, `e11_tool_call_mix` (Task 5); the `exec-driver` binary (Task 3); `remote-worker/cmd/null-responder` (already on this branch).
- Produces: nothing. This is the test that proves the two halves fit.

Every earlier test checks one side of the boundary. This one runs the **real** plan writer, hands its output to the **real** `exec-driver` binary, pointed at the **real** `null-responder`, and reads the times files. It needs no `/proc`, no cgroups, no KVM and no cluster, so it runs everywhere the rest of the suite does — which is the only reason the seam can be verified at all on a development machine, since `e11-density.sh` itself needs Linux.

It **skips** rather than fails when `go` is absent, matching how the suite treats tools it cannot assume. A skip prints a visible line: a silent skip is how a seam test stops testing anything.

- [ ] **Step 1: Write the test**

Append to `deploy/microvm/tests/e11-density.test.sh`:

```bash
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

  if [ "$seam_rc" -eq 0 ]; then
    # An ephemeral-ish port well away from the driver's defaults (8444/8445), so a stray relay
    # or responder from another run cannot answer this test's Execs.
    seam_port=18447
    "$seam_dir/null-responder" --listen "127.0.0.1:$seam_port" >"$seam_dir/responder.log" 2>&1 &
    seam_pid=$!
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
      check "  ...every line is '<ms> <status> <cause>' with status ok" \
        "$(awk 'NF==3 && $2=="ok" && $3=="-" && $1 ~ /^[0-9]+$/ {n++} END{print n+0}' "$seam_dir/slot-$i.times")" \
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
  fi
  rm -rf "$seam_dir"
fi
```

- [ ] **Step 2: Run it**

```bash
bash deploy/microvm/tests/e11-density.test.sh 2>&1 | sed -n '/the real write_rung_plan drives/,/^== /p'
```

Expected: every check `ok`. If `both binaries build` fails, read `$seam_dir/build.log` — but note the `rm -rf` at the end removes it, so on a failure re-run with that line commented out.

- [ ] **Step 3: Prove the test is not vacuous**

A green seam test that would stay green if the binary did nothing is worthless. Break the binary deliberately, confirm the test goes red, then restore it:

```bash
cd remote-worker
cp cmd/exec-driver/drive.go /tmp/drive.go.bak
# Make runSlot write one line fewer than the contract requires.
sed -i '' 's/for i := 0; i < calls; i++ {/for i := 0; i < calls-1; i++ {/' cmd/exec-driver/drive.go
cd .. && bash deploy/microvm/tests/e11-density.test.sh 2>&1 | grep -c 'FAIL.*wrote iters+warmup lines'
cp /tmp/drive.go.bak remote-worker/cmd/exec-driver/drive.go
cd remote-worker && gofmt -l ./cmd/exec-driver/ && go test ./cmd/exec-driver/ >/dev/null && echo RESTORED
```

Expected: the middle command prints `3` (one failure per slot), and the last prints `RESTORED`. If it prints `0`, the seam test is not actually reading the binary's output and must be fixed before this task is done.

- [ ] **Step 4: Run the whole deploy suite, not just this file**

```bash
for t in deploy/microvm/tests/*.test.sh; do echo "== $t"; bash "$t" >/tmp/$(basename "$t").log 2>&1 || echo "FAILED: $t"; tail -1 /tmp/$(basename "$t").log; done
```

Expected: every suite reports `Total failures: 0` and nothing prints `FAILED:`.

- [ ] **Step 5: Commit**

```bash
git add deploy/microvm/tests/e11-density.test.sh
git commit -s -m "test(e11): close the bash-to-Go seam end to end (#294)

The real write_rung_plan, the real exec-driver binary, the real
null-responder, and the times files read back. e11-density.sh itself needs
/proc, cgroups and Linux, so this is the only place the seam can be
verified on a development machine -- and it needs none of them.

Skips visibly when go is absent. A silent skip is how a seam test stops
testing anything.

Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

### Task 9: Document it, and measure what can be measured here

**Files:**

- Modify: `deploy/microvm/EXPERIMENTS.md` — extend the §E11 under-repair banner (lines 699–735), which already ends on the `driverControlChunkDecode` lower-bound caveat this work supersedes.
- Create: `docs/notes/e11-go-exec-client-comparison-runbook.md`

**Interfaces:**

- Consumes: everything above.
- Produces: the runbook the metal comparison follows, and an honest record of what this machine could and could not show.

The banner's existing last paragraph says the `driver-control` subtraction "is what will say whether the re-run can separate backend from driver at all." It has now said it, and the answer was no. That paragraph needs the result appended, not replaced — the numbers stay, as the banner itself insists.

- [ ] **Step 1: Extend the §E11 banner**

Append to the blockquote at `deploy/microvm/EXPERIMENTS.md` line 735 (immediately after the `driverControlChunkDecode` sentence, still inside the `>` block):

```markdown
> **2026-09-18 — that subtraction has now been measured, and the answer is that the
> instrument could not separate backend from driver.** On the same bare-metal rig, at
> `ITERS_PER_SLOT=200` and `SAMPLE_INTERVAL_MS=250`, the `driver-control` arm — no relay, no
> Redis, no worker, no VMM, and a responder that executes nothing — peaked at `c=8` and then
> declined, reaching `coresBusy` 64.13 of 72 and `hostCpuFractionPeak` 0.9598 at `c=64` with
> its own p95 of 753 ms against the published microVM arm's 1686 ms. The published `c=8` knee
> is reproduced by an arm with no backend at all. Corroborating that the arm measures what it
> claims: `postLoadHostCpuFraction` sits at 0.0006–0.0010 at every rung, so the pre-#291
> sampling method reproduces this section's "0.001 flat across the entire ladder" exactly
> while the under-load mean climbs to 0.89.
>
> The cause is one `execve` per Exec: `grpcurl` re-parses the proto descriptor set and opens a
> fresh TCP connection and HTTP/2 session per call. Issue #294 replaced it with
> `remote-worker/cmd/exec-driver`, which holds one `grpc.ClientConn` for a whole rung and runs
> `c` goroutines in place of `c` bash subshells. Select it with `SH_E11_EXEC_CLIENT=go`; every
> rung record carries `execClient`, and records from the two clients are **not** comparable
> except deliberately, as the two halves of that comparison.
>
> Until both clients have run against the null-responder on the host that produced the table
> above, **this section's conclusions stay under repair**: a sweep run now would measure the
> driver's knee again. The runbook is `docs/notes/e11-go-exec-client-comparison-runbook.md`.
```

- [ ] **Step 2: Write the runbook**

Create `docs/notes/e11-go-exec-client-comparison-runbook.md`:

````markdown
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
````

## Before quoting any number

- **`hostCpuSamples` per rung.** A mean of one or two ticks cannot score a saturation
  verdict, and the driver warns at run time when a rung produced fewer than five. The
  reference run's 15–103 is healthy at these settings; a faster client produces _shorter_
  windows, so the Go run's counts will be lower and may need `ITERS_PER_SLOT` raised.
- **`execClient` in every record.** If it says `grpcurl-per-exec` in the `.results-go`
  directory, the env var did not take and the comparison is of one client with itself.
- **`SH_E11_COLD_LATENCY_MS`.** Irrelevant to this comparison's headline numbers but it feeds
  `coldAcquireRate`; on a host where the warm hot-path p50 is 240 ms the shipped 50 ms default
  classifies everything as cold. Derive it from E10 on the same host, as issue #291's
  shakedown did.
- **`SH_E11_VMM_PROC_PATTERN`.** Not used by this arm (no VMM), but scope it before any
  microvm run: the unscoped `firecracker` pattern matched another user's shell on the metal
  box, and under `sudo` a foreign process's PSS would be summed in.

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

````

- [ ] **Step 3: Run the local indicative comparison**

This machine is 10 cores and not Linux, so this is **not** the acceptance comparison. It is worth doing because it proves both clients work against the same responder and gives a first-order signal. Run both against the null-responder directly, bypassing `e11-density.sh` (which needs `/proc`):

```bash
cd remote-worker && go build -o /tmp/null-responder ./cmd/null-responder && go build -o /tmp/exec-driver ./cmd/exec-driver && cd ..
/tmp/null-responder --listen 127.0.0.1:18450 >/tmp/nr.log 2>&1 &
NR_PID=$!
sleep 1

for C in 1 4 8; do
  mkdir -p /tmp/e11-cmp/go-$C && python3 - "$C" <<'PLANJSON'
import json, sys
c = int(sys.argv[1])
p = {"target": "localhost:18450", "sandboxId": "e11-driver-control", "itersPerSlot": 200,
     "warmupPerSlot": 3, "execTimeoutS": 30, "callDeadlineS": 45, "mix": ["true"],
     "slots": [{"reqBase": i*1000000, "workspaceKey": "",
                "timesFile": f"/tmp/e11-cmp/go-{c}/slot-{i}.times",
                "errFile": f"/tmp/e11-cmp/go-{c}/slot-{i}.err"} for i in range(1, c+1)]}
open(f"/tmp/e11-cmp/go-{c}/plan.json", "w").write(json.dumps(p))
PLANJSON
  t_start=$(python3 -c 'import time;print(time.time())')
  /tmp/exec-driver --plan /tmp/e11-cmp/go-$C/plan.json
  t_end=$(python3 -c 'import time;print(time.time())')
  echo "go c=$C wall=$(python3 -c "print(f'{$t_end-$t_start:.2f}')")s p95=$(cat /tmp/e11-cmp/go-$C/*.times | awk '{print $1}' | sort -n | awk '{a[NR]=$1}END{print a[int(0.95*NR)]}')ms"
done

for C in 1 4 8; do
  t_start=$(python3 -c 'import time;print(time.time())')
  gpids=()
  for i in $(seq 1 "$C"); do
    ( for n in $(seq 1 203); do
        grpcurl -plaintext -max-time 45 -import-path proto -proto sandbox/v1/sandbox.proto \
          -d "{\"sandbox_id\":\"e11-driver-control\",\"exec\":{\"req_id\":$((i*1000000+n)),\"command\":\"true\",\"timeout_s\":30}}" \
          localhost:18450 sandbox.v1.SandboxExec/Exec >/dev/null 2>&1
      done ) &
    gpids+=("$!")
  done
  # Wait on the grpcurl subshells ONLY. A bare `wait` would also wait on the null-responder,
  # which never exits on its own, so the loop would hang.
  for gp in "${gpids[@]}"; do wait "$gp"; done
  t_end=$(python3 -c 'import time;print(time.time())')
  echo "grpcurl c=$C wall=$(python3 -c "print(f'{$t_end-$t_start:.2f}')")s"
done
kill "$NR_PID"
````

Record both wall times per `c` in the task report. Expected: the Go path is several times faster per Exec. **Label it indicative only** — 10 cores, macOS, no `/proc` sampling, `mix` reduced to one command, and no host CPU measurement at all. It is not the 72-core comparison #294's acceptance names, and the report must say so in those words.

- [ ] **Step 4: Format and commit**

```bash
PRETTIER=/Users/paolo/Projects/aiplatform/serverless-harness/node_modules/.bin/prettier
"$PRETTIER" --write deploy/microvm/EXPERIMENTS.md docs/notes/e11-go-exec-client-comparison-runbook.md
"$PRETTIER" --check deploy/microvm/EXPERIMENTS.md docs/notes/e11-go-exec-client-comparison-runbook.md
# Prettier CORRUPTS a blockquote when it wraps a long inline code span: the "> " prefix
# vanishes from the continuation line, the paragraph silently leaves the quote, and lint still
# passes. The §E11 banner added in Step 1 is a blockquote containing
# `docs/notes/e11-go-exec-client-comparison-runbook.md`, which is long enough to trigger it.
# Check the rendered block after formatting and shorten the span if a line lost its prefix.
awk '/^> \*\*2026-09-18/,/^$/' deploy/microvm/EXPERIMENTS.md | grep -vc '^>'
git add deploy/microvm/EXPERIMENTS.md docs/notes/e11-go-exec-client-comparison-runbook.md
git commit -s -m "docs(e11): record what the driver-control arm settled, and the comparison runbook (#294)

The banner already said the driver-control subtraction was what would say
whether the re-run can separate backend from driver. It has said it, and
the answer was no: an arm with no backend reproduces the published c=8
knee and burns 64 of 72 cores at c=64. Appended rather than rewritten,
because the numbers stay as the record of what the broken instrument
produced.

Section E11 stays under repair until both clients have run against the
null-responder on the host that produced the table. The runbook holds the
reference numbers, the two invocations, and the checks to make before
quoting anything.

Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

## Final verification, before the PR

- [ ] **Everything, in one pass**

```bash
cd remote-worker && gofmt -l ./cmd/exec-driver/ && go vet ./... && go test ./... 2>&1 | tail -20; echo "GO:$?"
cd .. && shellcheck -x -S warning deploy/microvm/e11-density.sh deploy/microvm/tests/e11-density.test.sh; echo "SHELLCHECK:$?"
for t in deploy/microvm/tests/*.test.sh; do bash "$t" >/tmp/$(basename "$t").log 2>&1 || echo "FAILED: $t"; done; echo "SUITES DONE"
git log --oneline origin/fix/291-e11-driver-artifact..HEAD
```

Expected: `gofmt` silent, `go vet` silent, Go tests pass, `SHELLCHECK:0`, no `FAILED:` lines, and one commit per task.

- [ ] **Confirm the reference path is untouched in substance**

```bash
git diff origin/fix/291-e11-driver-artifact..HEAD -- deploy/microvm/e11-density.sh | grep '^-' | grep -v '^---' | grep -c 'grpc_exec_record\|grpcurl'
```

Expected: at most the lines re-indented into the `else` branch in Task 6. If `grpc_exec_record`'s own body appears as removed, the reference path was modified and the comparison is invalid.

- [ ] **Open the PR against #293's branch, not `main`**

```bash
gh pr create --base fix/291-e11-driver-artifact --head feat/294-e11-go-exec-client \
  --title "feat(e11): a persistent-connection Go Exec client (#294)" --body-file /tmp/pr-294-body.md
```

The body must state: what it builds, that it is opt-in, the `ExecError` finding as a candidate separate issue, that the acceptance comparison is **not** run and why, and a pointer to the runbook. Use `🤖 Generated with [Claude Code](https://claude.com/claude-code)` as the last line.
