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
