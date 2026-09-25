# Experiments moved

The E1/E3/E4/E6/E7 experiment drivers, `run-experiments.sh` (their E1/E3/E4 orchestrator), the
SWE-bench sandbox-build/measure scripts, and `EXPERIMENTS.md` that used to live in this
directory have moved to [rossoctl/moca-experiments](https://github.com/rossoctl/moca-experiments),
with their git history preserved (except `lib.sh`, copied there as a point-in-time snapshot
since the original stays here, shared by scripts that did not move).

See that repo's `knative/` directory for the E1 (economics/benefit), E3 (mobility), E4
(recovery), E6 (saturation), and E7 (converge-contention) drivers and their results.
