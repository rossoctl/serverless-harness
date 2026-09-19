import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectKnee, type LadderPoint } from './sharing.js';

/**
 * E11 (spec §7.3): sweep concurrent active runs x D x GuestRAMBytes through the relay
 * against P6's model stub, driving the Exec mix E10 measured. One rung of that sweep.
 *
 * Field notes (spec §7.1, §7.3, §7.5):
 *  - `pssBytes` MUST be Sigma PSS across the VMM and virtiofsd processes, sampled from
 *    /proc/<pid>/smaps_rollup -- never RSS. With MAP_PRIVATE sharing, summing RSS across
 *    ~200 VMM processes multiplies the shared set by ~200 ("~50 GiB where the truth is
 *    ~2 GiB", spec §7.3's boxed warning) -- wrong by more than an order of magnitude in
 *    the pessimistic direction, which would cause the project to abandon a design that
 *    works. The driver that produces this field must fail rather than fall back to RSS
 *    if smaps_rollup is unreadable; this module trusts whatever it is handed.
 *  - `standbysResident` and `idleStandbyResidency` are DIFFERENT claims (spec §7.1): the
 *    first is what is resident while the rung is active (a memory-and-process
 *    statement, not a throughput claim); the second is what is still resident once the
 *    rung has gone idle (a reclamation-cost statement). Conflating them hides which of
 *    "the design is working" or "the design is wasting" is true.
 *  - `leaseSaturations` is a hard admission-control signal, not a soft one (spec §6):
 *    the lease cap sits in front of the VM tier, so a saturated lease means the rung
 *    never actually exercised the VM tier's own limit. See analyzeLadder's lease guard.
 *  - The four host signals -- `pssBytes`, `memAvailableBytes`, `hostCpuFraction`,
 *    `processCount` -- are sampled DURING the rung's timed window and carry that window's
 *    MEAN. Before issue #291 they were sampled after every slot had exited, and
 *    `host_cpu_fraction` then slept one second and diffed /proc/stat across that window, so
 *    all four described a quiesced machine. The consequence was not merely weak evidence:
 *    `crosses('cpu')` tests `hostCpuFraction >= 0.9`, so a post-load 0.0006 on a 72-cpu host
 *    made the `cpu` bound structurally unable to fire at ANY rung, and E11's "no CPU ceiling
 *    was reached" was a restatement of the sampling bug. Records written before the fix carry
 *    no `samplingMode`; records written after carry `"in-rung-1hz-mean"`. The two are NOT
 *    comparable on any of these four fields.
 *  - The mean, not the peak, is what `hostCpuFraction` carries, and that choice is narrower
 *    than "the mean is more representative". `scorePrediction1` flips sealed prediction 1
 *    straight to `falsified` if CPU crosses 0.9 anywhere while memory and process-count never
 *    do. Scoring that off a single one-second peak -- a GC pause, a `drop_caches`, an
 *    unrelated process on a shared box -- would be the same class of error as the artifact
 *    being fixed, pointed the other way. The mean matches what `crosses('cpu')` asserts:
 *    THIS RUNG WAS CPU-SATURATED, not "this rung once touched saturation". Nothing is lost,
 *    because `hostCpuFractionPeak` is recorded beside it.
 */
export interface RungSample {
  /** Concurrent active runs at this rung. */
  c: number;
  /** Aggregate Execs/sec sustained at this rung. */
  throughput: number;
  /** Per-Exec p95 latency (ms) at this rung. */
  p95Ms: number;
  /** Fraction of acquires this rung that had to cold-replenish rather than pop a warm standby. */
  coldAcquireRate: number;
  /**
   * The latency threshold (ms) the driver used to CLASSIFY an acquire as cold. Optional
   * because older records predate the field. It is needed to tell a real result from a
   * degenerate one: coldAcquireRate is a latency proxy, so a threshold below what a WARM
   * acquire costs on this arm classifies every Exec as cold and the metric then measures
   * the threshold rather than the pool. See scoreColdAcquireShape.
   */
  coldLatencyThresholdMs?: number;
  /** Sigma PSS (bytes) across VMM + virtiofsd, from /proc/<pid>/smaps_rollup. Never RSS. */
  pssBytes: number;
  /** Host MemAvailable (bytes) sampled at this rung. */
  memAvailableBytes: number;
  /** Host CPU utilisation fraction, in [0, 1]. */
  hostCpuFraction: number;
  /** Total host process count attributable to the pool at this rung. */
  processCount: number;
  /** Standbys resident while the rung is active -- a memory-and-process statement. */
  standbysResident: number;
  /** Standbys still resident after the rung went idle and both signals converged. */
  idleStandbyResidency: number;
  /** Count of harness-side lease-cap refusals observed at this rung. Must be 0. */
  leaseSaturations: number;
  /** ExecError counts at this rung, keyed by cause (e.g. "memory-gate", "process-limit"). */
  execErrorsByCause: Record<string, number>;

  /**
   * The rest of this interface is what the driver RECORDS beside each mean (issue #291 §5).
   * All optional, because records written before that fix do not have them, and no scorer
   * reads any of them: they exist so a mean can always be checked against what it averaged.
   */
  /** Highest and lowest `hostCpuFraction` tick over the timed window. */
  hostCpuFractionPeak?: number;
  hostCpuFractionMin?: number;
  /**
   * Sampler ticks behind `hostCpuFraction`. Exposes thin rungs: a fast `c=1` rung may yield
   * only 2-3 samples, and a mean of 2 samples deserves a visible caveat.
   */
  hostCpuSamples?: number;
  /** `hostCpuFraction` x the host's online CPU count. "0.043 cores" is legible; 0.0006 is not. */
  coresBusy?: number;
  /** Lowest `memAvailableBytes` tick -- the only extreme of this signal that indicates pressure. */
  memAvailableBytesMin?: number;
  /** Highest Sigma PSS tick over the timed window. */
  pssBytesPeak?: number;
  /**
   * Ticks behind `pssBytes` / `processCount`. Lower than `hostCpuSamples` by design: those two
   * need `pgrep` plus an N-file smaps_rollup walk, so the driver takes them every Nth tick
   * (default 5, always including tick 1). Defensible because `crosses('memory')` reads
   * `memAvailableBytes`, which IS every tick -- PSS feeds the narrative, not the bound.
   */
  pssSamples?: number;
  /**
   * Low-cadence ticks where the sampler DID try to read PSS but the read was refused (a
   * still-live VMM/virtiofsd pid with an unreadable smaps_rollup -- spec section 7.3's boxed
   * warning never falls back to RSS, so this fires instead). Not part of `pssSamples`, which
   * only counts ticks that produced a number: a refusal is a distinct, countable event, not
   * an ordinary un-sampled tick (issue #291 item 4). No scoring logic reads this field today;
   * it exists so a rung with a suspiciously low `pssSamples` can be told apart from one that
   * simply landed on few low-cadence ticks.
   */
  pssRefusedTicks?: number;
  processCountSamples?: number;
  /** Highest `processCount` tick over the timed window. */
  processCountPeak?: number;
  /**
   * How the four host signals above were taken. `"in-rung-1hz-mean"` since issue #291;
   * absent on older records, which took them from an idle host after the window closed.
   */
  samplingMode?: string;
  /**
   * Which client issued this rung's Execs: `"grpcurl-per-exec"` (one process per call, the
   * reference path) or `"go-persistent-conn"` (remote-worker/cmd/exec-driver, one connection
   * per rung). Absent on records written before issue #294. NOTHING here scores it -- like
   * `samplingMode`, it exists so a ladder's numbers can be attributed rather than merely
   * compared, because the driver's own cost was 753ms of the published microVM arm's 1686ms
   * p95 at c=64.
   */
  execClient?: string;
  /**
   * The retained post-load snapshot, taken once after every slot exited. Kept under its own
   * names precisely so an idle reading can never again pass as an under-load one. NOTHING in
   * this module reads these.
   */
  postLoadHostCpuFraction?: number;
  postLoadMemAvailableBytes?: number;
  postLoadPssBytes?: number;
  postLoadProcessCount?: number;
}

export type Bound = 'replenishment' | 'memory' | 'process-count' | 'cpu';
export type Verdict = 'supported' | 'falsified' | 'inconclusive';

export interface DensityReport {
  /** The highest c still healthy, per detectKnee(points, 2). */
  knee: number;
  /** The resource that bound the ladder, attributed at the first rung any signal crossed. */
  bound: Bound;
  /** Standbys resident at the knee -- reported separately per spec §7.1. */
  standbysResident: number;
  /** Idle standby residency at the knee, once converged -- reported separately. */
  idleStandbyResidency: number;
  /** §7.4's five predictions, scored against deploy/microvm/predictions.json, keyed by id. */
  predictions: Record<number, Verdict>;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PREDICTIONS_FILE = resolve(REPO_ROOT, 'deploy/microvm/predictions.json');

interface PinnedPrediction {
  id: number;
  claim: string;
}

/**
 * Reads deploy/microvm/predictions.json for the prediction IDENTITIES (ids) only.
 * Never edited by this module -- the Task 19 pin (`microvm-predictions.test.ts`) covers
 * the file's content; this just makes sure the report's keys cannot drift from what was
 * actually committed to before any rung ran.
 */
function pinnedPredictionIds(): number[] {
  const doc = JSON.parse(readFileSync(PREDICTIONS_FILE, 'utf8')) as {
    predictions: PinnedPrediction[];
  };
  return doc.predictions.map((p) => p.id);
}

const SIGNAL_PRIORITY: Bound[] = ['replenishment', 'memory', 'process-count', 'cpu'];

const NEAR_ZERO_COLD_ACQUIRE = 0.05;
const MEMORY_COLLAPSE_FRACTION = 0.5; // MemAvailable dropping below half its baseline
const PROCESS_COUNT_BLOWUP = 5; // processCount/c ratio growing past 5x baseline's ratio
const CPU_SATURATION_FRACTION = 0.9;

function crosses(signal: Bound, baseline: RungSample, cur: RungSample): boolean {
  switch (signal) {
    case 'replenishment':
      return cur.coldAcquireRate - baseline.coldAcquireRate > NEAR_ZERO_COLD_ACQUIRE;
    case 'memory':
      return (
        cur.memAvailableBytes < baseline.memAvailableBytes * MEMORY_COLLAPSE_FRACTION ||
        Object.entries(cur.execErrorsByCause).some(([cause, n]) => n > 0 && /mem/i.test(cause))
      );
    case 'process-count': {
      const baselineRatio = baseline.processCount / baseline.c;
      const curRatio = cur.processCount / cur.c;
      return (
        curRatio > baselineRatio * PROCESS_COUNT_BLOWUP ||
        Object.entries(cur.execErrorsByCause).some(
          ([cause, n]) => n > 0 && /pid|process|nofile/i.test(cause),
        )
      );
    }
    case 'cpu':
      return cur.hostCpuFraction >= CPU_SATURATION_FRACTION;
  }
}

/** The lowest `c` (ascending, excluding baseline) at which `signal` crosses, or Infinity. */
function firstCrossing(signal: Bound, baseline: RungSample, rest: RungSample[]): number {
  for (const cur of rest) {
    if (crosses(signal, baseline, cur)) return cur.c;
  }
  return Infinity;
}

/**
 * Attribute the bound by comparing, across rungs, which signal crossed its threshold
 * first (spec §7.3): cold-acquire rate rise (replenishment), MemAvailable collapse or a
 * memory-gate ExecError (memory), processCount blowing up relative to concurrency
 * (process-count), host CPU fraction saturating (cpu). Ties resolve to whichever
 * crossed first ACROSS RUNGS -- not whichever signal is largest at the unhealthy rung --
 * with `SIGNAL_PRIORITY` breaking ties at the same rung.
 */
function attributeBound(baseline: RungSample, rest: RungSample[]): Bound {
  const crossings = SIGNAL_PRIORITY.map((signal) => ({
    signal,
    at: firstCrossing(signal, baseline, rest),
  }));
  crossings.sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at;
    return SIGNAL_PRIORITY.indexOf(a.signal) - SIGNAL_PRIORITY.indexOf(b.signal);
  });
  if (crossings[0].at !== Infinity) return crossings[0].signal;

  // No signal crossed its threshold anywhere in the ladder (e.g. a synthetic p95-only
  // regression with none of the four host signals moving). Fall back to whichever moved
  // most, relatively, at the last rung, so the report always names a candidate rather
  // than throwing on data that never exercised a real resource limit.
  const last = rest[rest.length - 1] ?? baseline;
  const memRatio = 1 - last.memAvailableBytes / Math.max(baseline.memAvailableBytes, 1);
  const cpuRatio = last.hostCpuFraction - baseline.hostCpuFraction;
  const coldRatio = last.coldAcquireRate - baseline.coldAcquireRate;
  const procRatio =
    last.processCount / last.c / Math.max(baseline.processCount / baseline.c, 1) - 1;
  const ranked: Array<{ signal: Bound; magnitude: number }> = [
    { signal: 'replenishment', magnitude: coldRatio },
    { signal: 'memory', magnitude: memRatio },
    { signal: 'process-count', magnitude: procRatio },
    { signal: 'cpu', magnitude: cpuRatio },
  ];
  ranked.sort((a, b) => b.magnitude - a.magnitude);
  return ranked[0].signal;
}

/**
 * Prediction 1 (§7.4): "Replenishment binds on process/memory count before CPU."
 * Falsified by CPU saturating at or before the memory/process gate first refuses.
 * Scored by comparing each signal's first-crossing rung, independent of which one
 * `attributeBound` eventually names the winner (a replenishment-bound ladder says
 * nothing about this race, so it reads inconclusive rather than supported).
 */
function scorePrediction1(baseline: RungSample, rest: RungSample[]): Verdict {
  const cpuAt = firstCrossing('cpu', baseline, rest);
  const memOrProcAt = Math.min(
    firstCrossing('memory', baseline, rest),
    firstCrossing('process-count', baseline, rest),
  );
  if (cpuAt === Infinity && memOrProcAt === Infinity) return 'inconclusive';
  return memOrProcAt <= cpuAt ? 'supported' : 'falsified';
}

/**
 * Prediction 3 (§7.4): "cold-acquire rate stays approximately 0 until replenishment rate
 * meets Exec rate, then rises sharply." A SHAPE claim -- a gradual rise falsifies it even
 * if the endpoint value matches, so this checks the whole curve, not just the last rung.
 */
function scoreColdAcquireShape(sortedByC: RungSample[], knee: number): Verdict {
  if (sortedByC.length < 2) return 'inconclusive';

  // Refuse to score when the cold/warm CLASSIFIER cannot discriminate on this arm.
  // coldAcquireRate is a latency proxy (an Exec counts as cold at or above
  // coldLatencyThresholdMs), so the threshold has to sit between a warm acquire's latency
  // and a cold one. The lowest-c rung is the warm case by construction -- one active run
  // against a full standby pool -- so if even ITS p95 is at or above the threshold, then
  // every Exec at every rung is classified cold no matter what the pool did, and a
  // "falsified" verdict would be a statement about the threshold.
  //
  // Measured on the validation rig: the microVM arm ran p95 236-266ms against a 50ms
  // default (resume alone is ~80ms), giving coldAcquireRate 1.0 at c=1 and a spurious
  // 'falsified' on sealed prediction 3; the container arm ran p95 40-41ms under the same
  // threshold and reported 0.0. The metric was reporting which arm it was on.
  const lowest = sortedByC[0];
  const threshold = lowest.coldLatencyThresholdMs;
  if (threshold !== undefined && lowest.p95Ms >= threshold) {
    return 'inconclusive';
  }

  // Split on the DETECTED KNEE, not on "everything except the last rung". The prediction says
  // the rate stays near zero *until replenishment rate meets Exec rate* and then rises sharply,
  // and the knee is by definition where that happens -- so the knee is what separates the two
  // halves of the claim.
  //
  // The old split assumed the ladder STOPS at the knee, so that the last rung was the only
  // saturated one. But locating a knee requires sweeping PAST it, and then "everything except
  // the last" fills up with saturated rungs and the shape test inverts. Measured on metal with
  // ACTIVE_RUNS="1 2 4 8 16 32 64", knee 8:
  //     c:     1     2     4     8    16    32    64
  //     cold: 0.00  0.00  0.03  0.22  0.84  1.00  1.00
  // which is exactly the predicted shape -- flat, then a sharp rise at the knee -- and the old
  // split scored it 'falsified' on BOTH arms, because c=8/16/32 sat in its "early" set. A wrong
  // verdict on a sealed prediction.
  const pre = sortedByC.filter((r) => r.c < knee);
  const post = sortedByC.filter((r) => r.c >= knee);
  // With the knee at the very first rung there is no pre-knee region to characterise, and with
  // nothing at or past it there is no rise to see. Either way the shape is unobserved, not
  // contradicted.
  if (pre.length === 0 || post.length === 0) return 'inconclusive';
  const preAllNearZero = pre.every((r) => r.coldAcquireRate <= NEAR_ZERO_COLD_ACQUIRE);
  const maxPre = Math.max(...pre.map((r) => r.coldAcquireRate));
  const maxPost = Math.max(...post.map((r) => r.coldAcquireRate));
  const sharpRise = maxPost - maxPre >= 0.3;
  if (preAllNearZero && sharpRise) return 'supported';
  if (pre.some((r) => r.coldAcquireRate > NEAR_ZERO_COLD_ACQUIRE)) return 'falsified';
  return 'inconclusive';
}

/**
 * Dispatches a scorable prediction id to its scorer. Predictions 2 (E10 rung ratio),
 * 4 (per-command-class breakdown across VMM arms) and 5 (post-rung convergence
 * time-series) each need data this ladder-of-RungSample shape does not carry -- they
 * score `inconclusive` here rather than guess. Any id this module does not recognise
 * (future predictions.json entries) also reads `inconclusive` rather than throwing, so
 * a legitimately-restated prediction file (Task 19's own escape hatch) does not crash
 * the analysis.
 */
function scorePrediction(
  id: number,
  baseline: RungSample,
  rest: RungSample[],
  sortedByC: RungSample[],
  // Threaded through for prediction 3, whose claim is explicitly about what happens BEFORE
  // versus AFTER the knee -- see scoreColdAcquireShape for what splitting on the wrong
  // boundary did to a sealed prediction on real metal data.
  knee: number,
): Verdict {
  switch (id) {
    case 1:
      return scorePrediction1(baseline, rest);
    case 3:
      return scoreColdAcquireShape(sortedByC, knee);
    default:
      return 'inconclusive';
  }
}

/**
 * Analyzes one E11 density ladder (spec §7.3). Reuses `detectKnee` with `degradeX=2`
 * rather than inventing a second detector; its "no c===1 baseline" error is allowed to
 * propagate unmodified, because failing here beats failing after a two-hour sweep.
 *
 * Refuses (throws) a ladder in which any rung recorded `leaseSaturations > 0`: the
 * lease cap is primary admission control (spec §6) in front of the VM tier, so a
 * saturated lease means the rung never reached the VM tier's own limit at all -- a
 * harness-side refusal misread as a VM-tier limit, which is P6 §6's lesson and not a
 * footnote (spec §7.3's last metric row).
 */
export function analyzeLadder(samples: RungSample[]): DensityReport {
  const saturated = samples.find((s) => s.leaseSaturations > 0);
  if (saturated) {
    throw new Error(
      `analyzeLadder: rung c=${saturated.c} saturated the lease cap ` +
        `(${saturated.leaseSaturations} refusal(s)) -- a harness-side refusal misread as a ` +
        'VM-tier limit; this rung never exercised the VM tier at all, so the whole ladder ' +
        'is invalid until the lease cap is raised or the sweep is scaled back (spec §6, §7.3).',
    );
  }

  const points: LadderPoint[] = samples.map((s) => ({
    c: s.c,
    throughput: s.throughput,
    p95Ms: s.p95Ms,
  }));
  const knee = detectKnee(points, 2);

  const sortedByC = [...samples].sort((a, b) => a.c - b.c);
  const baseline = sortedByC.find((s) => s.c === 1);
  // detectKnee above already throws "no c=1 baseline point" when this is missing, so by
  // construction baseline exists here. The guard is only to satisfy the type checker.
  if (!baseline) throw new Error('analyzeLadder: no c === 1 baseline point');
  const rest = sortedByC.filter((s) => s.c !== 1);

  const bound = attributeBound(baseline, rest);

  const kneeRung = sortedByC.find((s) => s.c === knee) ?? baseline;

  const predictions = Object.fromEntries(
    pinnedPredictionIds().map((id) => [id, scorePrediction(id, baseline, rest, sortedByC, knee)]),
  );

  return {
    knee,
    bound,
    standbysResident: kneeRung.standbysResident,
    idleStandbyResidency: kneeRung.idleStandbyResidency,
    predictions,
  };
}
