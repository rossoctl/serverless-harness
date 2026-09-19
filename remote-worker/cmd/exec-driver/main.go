// Command exec-driver is E11's persistent-connection Exec client (issue #294).
//
// It replaces the ONE remaining per-Exec process spawn in deploy/microvm/e11-density.sh's
// timed window. PR #293 removed the other ~8 spawns per Exec (two of them Python
// interpreters); what was left was one execve of grpcurl, which re-parses the proto
// descriptor set and opens a fresh TCP connection and HTTP/2 session before sending a single
// request. Measured on metal with the driver-control arm -- no relay, no Redis, no worker, no
// VMM -- that driver alone peaked at c=8 and then declined, burning 64 of 72 cores at c=64
// with its own p95 of 753ms against the published microVM arm's 1686ms. The published knee
// was the driver's. Those two figures are not the same instrument twice -- 753ms is PR
// #293's repaired driver at ITERS_PER_SLOT=200, 1686ms is the pre-#291 driver at
// ITERS_PER_SLOT=20 -- and that mismatch runs in this finding's favor, not against it.
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
