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
