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
