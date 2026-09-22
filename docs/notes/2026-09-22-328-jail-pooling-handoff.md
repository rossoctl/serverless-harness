# Handoff: pooling the Firecracker jail (#328)

One implementation task, in a fixed order, plus one design decision to settle before writing code.
Written 2026-09-22 so the next session starts from the decisions rather than rediscovering them.

## The finding in one paragraph

The wait for Firecracker's API socket (`sockwait`, 72-85% of every restore) is **82-85% the jailer
building a fresh chroot per VM**, not Firecracker. Firecracker binds its socket in ~1.5 ms. The
jailer will **reuse** an existing jail directory, and doing so halves the pre-socket window:
8275 us cold, 4025 us and 4008 us reused. Since replenishment is restores and the replenishment rate
is what bounds throughput, this is the live lever. Measurements and method are in #328.

## Do these in this order

### 1. Split the phase accounting first — it is the instrument for everything else

`launcher_firecracker.go` times the `jailer` phase with `time.Since` after `cmd.Start()` returns, so
it measures **fork/exec returning** (0.34-1.62 ms across a whole ladder) while the jailer's 6-8 ms of
chroot construction lands in the `sockwait` bucket.

Split `sockwait` into `jailer_setup` (until the jailed `execve`) and `fc_bind`. Getting the jailed
`execve` boundary from inside the launcher is the tricky part — the jail directory appearing, or the
`firecracker.pid` file, are candidate observable proxies; neither is obviously right, so pick one and
say in a comment why.

**Why this is not optional:** the mis-attribution cost two full rounds of analysis chasing
"Firecracker is slow to bind". If it stays, it will equally obscure whether the pool worked.

### 2. Implement the jail pool, mirroring `cgroup_pool.go`

`vmpool/cgroup_pool.go` (#319) is the template and the review comments on #319 are the specification:
a free list, **verify on pop**, a name allocator that **never reclaims a name after a failed mint**
(because `MkdirAll` returns nil on an existing dir, so rollback could alias a live holder), refuse to
reuse a dirty one and **count the leak** rather than reusing optimistically, and drop a vanished one
instead of trusting it.

Reuse is keyed on the jailer's `--id`, which is what determines the chroot path
(`<chroot-base>/firecracker/<id>/root`) — so pooling the jail means pooling the id. Check what else
`--id` feeds; Firecracker also takes it as its instance identifier.

### 3. Re-measure, and measure the right two things

Expect the pre-socket window to fall from ~8 ms toward ~4 ms **at low load**. The reuse test says
nothing about the load-dependent half (`sockwait` mean 9.78 ms at c=8 rising to 22.31 ms at c=64), so
report both: the floor and the slope. A fix that halves the floor and leaves the slope alone is still
a win, but it is a different win from the one a single 64-slot number would suggest.

## The design decision to settle BEFORE writing the pool

**A pooled jail is a directory the previous VM had write access to.** This is the only place in #328
where a performance change touches isolation, so decide it explicitly rather than discovering it.

What a reused jail contains:

```
root/api.sock            <- per-VM residue
root/firecracker.pid     <- per-VM residue
root/firecracker         <- the copied exec file; reusing it is most of the saving
root/dev/{kvm,urandom,userfaultfd,net}
root/run
```

Questions to answer in the design note or the PR description:

1. What must be removed before reuse, and what may persist? The device nodes can stay. `api.sock` and
   `firecracker.pid` are residue. The copied `firecracker` binary is the saving — so the policy has to
   permit _that_ file to persist while guaranteeing nothing else does.
2. How is "clean" verified rather than assumed? `cgroupPool` refuses a cgroup with a live process in
   it; the jail equivalent is a directory listing against an allowlist, which fails closed.
3. Does the workspace/rootfs image live inside the jail? If so, its handling dominates this question
   and the answer may be that only the _shell_ of the jail is poolable.

Recommendation: allowlist what may persist, delete everything else, and refuse to reuse a jail whose
contents do not match — counting that as a leak, exactly as the cgroup pool does.

## Do not re-investigate these

- **`--no-api` / `--config-file`.** Tested: the config schema requires `drives` + `boot-source` and
  then asks for the kernel image — it is a fresh-boot config. A `snapshot` key is **silently ignored**
  (unknown fields are not rejected, so this fails open into a fresh boot). Snapshot restore is
  API-only in v1.17.0. We also need the API twice: `PUT /snapshot/load` and later
  `PATCH /vm {state: Resumed}`, because standbys are deliberately left paused.
- **Telling the jailer to skip `/dev/net/tun`.** `jailer --help` on v1.17.0 exposes no device-node
  control; the four `mknod`s are hardcoded. Would require patching or replacing the jailer.
- **Skipping the jailer entirely** (#328 option 2). Deprioritised, not rejected: pooling gets most of
  the win without reimplementing isolation. Revisit only if pooling underdelivers.

## Two numbers in #328's body are wrong

Corrected in its comments, repeated here because they are the ones most likely to be quoted:

- `sockwait` at 64 slots is **22-25 ms, not 38.07 ms**. The original came from a sweep with caches
  dropped once at the start and ~1000 accumulated dying cgroups — host state, not `sockwait`.
- The **238.72 / 869.43 ms** figures were at 128 and 256 **slots**, i.e. over-subscription past the
  throughput peak. That is a different configuration, not the same one under more load.

## Rig notes that will otherwise cost an hour each

- Per-rung results go in `RESULTS=<dir>`. There is no `SH_E11_RESULTS_DIR`; an unknown name is
  silently ignored, every rung shares the default `.results/`, and the worker log is **truncated** per
  invocation, so only the last rung's phase lines survive. That cost one full ladder.
- `sched_schedstats` is **off**, so `/proc/<pid>/sched` carries no `se.statistics.*` fields. A
  starvation probe reading `wait_sum` silently measures nothing.
- Do not put `sudo` inside a timing clock. It is a setuid binary doing PAM work and cost ~13 ms of a
  16 ms "measurement" — pay it once, outside the loop.
- `pgrep -f` self-matches through its own ssh and sudo argv. Count with `ps` filtered against
  `bash -c`; never clean up with `pkill -f`.
- Count VMMs as root via `/proc/*/exe`; an unprivileged probe reports a flat 0, which reads as
  "nothing is running".
- The box is shared with another user. Check `who` and sample foreign load before any authoritative
  run, and leave swap off and the governor at `performance`.

Refs #328, #319, #307, #274. Campaign context: `2026-09-22-exec-throughput-campaign-results.md`.
