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
