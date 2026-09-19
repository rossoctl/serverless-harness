import { describe, expect, it } from 'vitest';
import { analyzeLadder, type RungSample } from '../src/microvm-density.js';

const rung = (over: Partial<RungSample> & { c: number }): RungSample => ({
  throughput: over.throughput ?? over.c,
  p95Ms: over.p95Ms ?? 100,
  coldAcquireRate: over.coldAcquireRate ?? 0,
  pssBytes: over.pssBytes ?? 1e9,
  memAvailableBytes: over.memAvailableBytes ?? 100e9,
  hostCpuFraction: over.hostCpuFraction ?? 0.2,
  processCount: over.processCount ?? 10 * over.c,
  standbysResident: over.standbysResident ?? 2 * over.c,
  idleStandbyResidency: over.idleStandbyResidency ?? 0,
  leaseSaturations: over.leaseSaturations ?? 0,
  execErrorsByCause: over.execErrorsByCause ?? {},
  ...over,
});

describe('E11 ladder analysis', () => {
  it('reuses detectKnee rather than inventing a second detector', () => {
    const r = analyzeLadder([
      rung({ c: 1 }),
      rung({ c: 2 }),
      rung({ c: 4 }),
      rung({ c: 8, p95Ms: 400 }),
    ]);
    // degradeX=2 per spec §7.3, and detectKnee's own contract: p95 within 2x of the
    // c===1 baseline AND throughput at/above the running max.
    expect(r.knee).toBe(4);
  });

  it('refuses a ladder with no single-run rung', () => {
    // detectKnee THROWS without a c === 1 baseline point (sharing.ts:14), so the ladder
    // must include the single-run rung. Failing here beats failing after a two-hour sweep.
    expect(() => analyzeLadder([rung({ c: 2 }), rung({ c: 4 })])).toThrow(/c === 1|baseline/);
  });

  it('attributes the bound to memory when MemAvailable collapses first', () => {
    const r = analyzeLadder([
      rung({ c: 1 }),
      rung({ c: 8 }),
      rung({ c: 16, throughput: 16, memAvailableBytes: 1e9, p95Ms: 400 }),
    ]);
    expect(r.bound).toBe('memory');
  });

  it('attributes the bound to replenishment when cold-acquire rate rises', () => {
    const r = analyzeLadder([
      rung({ c: 1 }),
      rung({ c: 8 }),
      rung({ c: 16, throughput: 8, coldAcquireRate: 0.6, p95Ms: 500 }),
    ]);
    // Spec §7.3 calls cold-acquire rate "the headline diagnostic" — it is what separates
    // "this design works" from "this is a per-call restore with extra steps".
    expect(r.bound).toBe('replenishment');
  });

  it('attributes the bound to CPU when neither memory nor replenishment moved', () => {
    const r = analyzeLadder([
      rung({ c: 1 }),
      rung({ c: 8 }),
      rung({ c: 16, throughput: 8, hostCpuFraction: 0.98, p95Ms: 500 }),
    ]);
    expect(r.bound).toBe('cpu');
  });

  it('refuses to report a knee that lease saturation could explain', () => {
    // P6 §6's lesson, restated by spec §7.3's last metric row: a harness-side refusal
    // misread as a VM-tier limit. Spurious refusals one tier up truncate the rungs and
    // make a knee read early, so this is a hard error rather than a footnote.
    expect(() =>
      analyzeLadder([
        rung({ c: 1 }),
        rung({ c: 8 }),
        rung({ c: 16, leaseSaturations: 12, p95Ms: 500 }),
      ]),
    ).toThrow(/lease/i);
  });

  it('scores prediction 3 against the KNEE, not against "all but the last rung"', () => {
    // The real metal ladder, ACTIVE_RUNS="1 2 4 8 16 32 64", knee 8. This is exactly the shape
    // prediction 3 asserts -- cold-acquire flat near zero, then a sharp rise once replenishment
    // stops keeping up -- and the old split scored it 'falsified' on BOTH arms, because it
    // treated everything except c=64 as the pre-knee region and c=8/16/32 are past saturation.
    // Locating a knee REQUIRES sweeping past it, so that split was wrong for any ladder long
    // enough to find one.
    const metalMicrovm = analyzeLadder([
      rung({
        c: 1,
        coldAcquireRate: 0.0,
        p95Ms: 124,
        coldLatencyThresholdMs: 145,
        throughput: 6.73,
      }),
      rung({
        c: 2,
        coldAcquireRate: 0.0,
        p95Ms: 121,
        coldLatencyThresholdMs: 145,
        throughput: 13.01,
      }),
      rung({
        c: 4,
        coldAcquireRate: 0.03,
        p95Ms: 142,
        coldLatencyThresholdMs: 145,
        throughput: 23.37,
      }),
      rung({
        c: 8,
        coldAcquireRate: 0.22,
        p95Ms: 175,
        coldLatencyThresholdMs: 145,
        throughput: 39.04,
      }),
      rung({
        c: 16,
        coldAcquireRate: 0.84,
        p95Ms: 353,
        coldLatencyThresholdMs: 145,
        throughput: 43.31,
      }),
      rung({
        c: 32,
        coldAcquireRate: 1.0,
        p95Ms: 788,
        coldLatencyThresholdMs: 145,
        throughput: 35.0,
      }),
      rung({
        c: 64,
        coldAcquireRate: 1.0,
        p95Ms: 1686,
        coldLatencyThresholdMs: 145,
        throughput: 32.84,
      }),
    ]);
    // The knee is real here: c=16's p95 (353) exceeds 2x the c=1 baseline (248), so 8 is the
    // last healthy rung rather than the top of the sweep.
    expect(metalMicrovm.knee).toBe(8);
    expect(metalMicrovm.predictions[3]).toBe('supported');
  });

  it('still falsifies prediction 3 when the rate is already high BEFORE the knee', () => {
    // The converse, and the reason the split matters rather than just the threshold: a rate
    // that is already elevated in the pre-knee region contradicts "stays approximately 0
    // until replenishment rate meets Exec rate", and must still be caught after the change.
    const preKneeAlreadyHot = analyzeLadder([
      rung({ c: 1, coldAcquireRate: 0.4, p95Ms: 20, coldLatencyThresholdMs: 200 }),
      rung({ c: 2, coldAcquireRate: 0.45, p95Ms: 22, coldLatencyThresholdMs: 200 }),
      rung({ c: 4, coldAcquireRate: 0.9, p95Ms: 300, coldLatencyThresholdMs: 200, throughput: 3 }),
    ]);
    expect(preKneeAlreadyHot.predictions[3]).toBe('falsified');
  });

  it('refuses to score prediction 3 when the cold/warm classifier cannot discriminate', () => {
    // The real microVM ladder from the validation rig. coldAcquireRate is a LATENCY proxy:
    // an Exec counts as cold at or above coldLatencyThresholdMs. Here the threshold is the
    // 50ms default while the arm's own p95 is 236-266ms (resume alone is ~80ms), so every
    // Exec at every rung is classified cold no matter what the pool did -- the metric is
    // reporting which arm it is on. Scored naively this reads 'falsified', which would put
    // a false verdict against a SEALED prediction in the readout.
    const degenerate = analyzeLadder([
      rung({
        c: 1,
        coldAcquireRate: 1.0,
        p95Ms: 266,
        coldLatencyThresholdMs: 50,
        throughput: 2.07,
      }),
      rung({
        c: 2,
        coldAcquireRate: 0.5,
        p95Ms: 236,
        coldLatencyThresholdMs: 50,
        throughput: 4.21,
      }),
    ]);
    expect(degenerate.predictions[3]).toBe('inconclusive');

    // Same 50ms threshold, but at the container arm's latencies (p95 40-41ms) the
    // classifier HAS headroom, so scoring must proceed normally -- shown by a ladder whose
    // shape is the supported one. (The rig's actual container ladder reads 'inconclusive'
    // for an unrelated and correct reason: its cold rate never rises at all.)
    const usable = analyzeLadder([
      rung({ c: 1, coldAcquireRate: 0, p95Ms: 41, coldLatencyThresholdMs: 50 }),
      rung({ c: 2, coldAcquireRate: 0, p95Ms: 40, coldLatencyThresholdMs: 50 }),
      rung({ c: 4, coldAcquireRate: 0.7, p95Ms: 45, coldLatencyThresholdMs: 50, throughput: 8 }),
    ]);
    expect(usable.predictions[3]).toBe('supported');
  });

  it('still falsifies prediction 3 when the classifier HAS headroom', () => {
    // The converse, and the point of the guard's shape: it must refuse only when the
    // threshold is the explanation, never swallow a real falsification. Here the warm rung
    // sits well under the threshold, so a high early cold rate is evidence about the pool
    // rather than about the classifier -- and prediction 3's shape claim is genuinely
    // contradicted by a gradual rise.
    const real = analyzeLadder([
      rung({ c: 1, coldAcquireRate: 0.4, p95Ms: 20, coldLatencyThresholdMs: 200 }),
      rung({ c: 4, coldAcquireRate: 0.5, p95Ms: 30, coldLatencyThresholdMs: 200 }),
      rung({ c: 8, coldAcquireRate: 0.6, p95Ms: 40, coldLatencyThresholdMs: 200, throughput: 8 }),
    ]);
    expect(real.predictions[3]).toBe('falsified');
  });

  it('scores prediction 3s shape, not just its direction', () => {
    const r = analyzeLadder([
      rung({ c: 1 }),
      rung({ c: 4, coldAcquireRate: 0 }),
      rung({ c: 8, coldAcquireRate: 0.01 }),
      rung({ c: 16, coldAcquireRate: 0.7, throughput: 8, p95Ms: 500 }),
    ]);
    // "cold-acquire rate stays approximately 0 until replenishment rate meets Exec rate,
    // then rises sharply" — a SHAPE claim, so a gradual rise falsifies it even if the
    // endpoint matches.
    expect(r.predictions[3]).toBe('supported');
    const gradual = analyzeLadder([
      rung({ c: 1, coldAcquireRate: 0.1 }),
      rung({ c: 4, coldAcquireRate: 0.2 }),
      rung({ c: 8, coldAcquireRate: 0.3 }),
      rung({ c: 16, coldAcquireRate: 0.4, throughput: 8, p95Ms: 500 }),
    ]);
    expect(gradual.predictions[3]).toBe('falsified');
  });

  // Issue #291: the four host signals are now sampled DURING the timed window, and the
  // record carries the extremes and sample counts beside each mean. This module's job is to
  // ACCEPT those fields and score exactly as before -- the whole repair is upstream, in the
  // driver, and a scorer change smuggled in alongside it would make the re-run
  // uninterpretable.
  const enriched = (over: Partial<RungSample> & { c: number }): RungSample => ({
    ...rung(over),
    hostCpuFractionPeak: (over.hostCpuFraction ?? 0.2) + 0.3,
    hostCpuFractionMin: 0.01,
    hostCpuSamples: 12,
    coresBusy: (over.hostCpuFraction ?? 0.2) * 72,
    memAvailableBytesMin: (over.memAvailableBytes ?? 100e9) * 0.9,
    pssBytesPeak: (over.pssBytes ?? 1e9) * 2,
    pssSamples: 3,
    processCountPeak: (over.processCount ?? 10 * over.c) + 2,
    processCountSamples: 3,
    samplingMode: 'in-rung-1hz-mean',
    postLoadHostCpuFraction: 0.0006,
    postLoadMemAvailableBytes: over.memAvailableBytes ?? 100e9,
    postLoadPssBytes: over.pssBytes ?? 1e9,
    postLoadProcessCount: over.processCount ?? 10 * over.c,
  });

  it("accepts the #291 record's new fields and scores identically without them", () => {
    const ladder: Array<Partial<RungSample> & { c: number }> = [
      { c: 1 },
      { c: 2 },
      { c: 4 },
      { c: 8, p95Ms: 400, coldAcquireRate: 0.4 },
    ];
    const plain = analyzeLadder(ladder.map(rung));
    const withNew = analyzeLadder(ladder.map(enriched));
    expect(withNew).toEqual(plain);
  });

  it('scores the cpu bound off hostCpuFraction, which is now the under-load mean', () => {
    // The pre-fix records had hostCpuFraction ~0.0006 at every rung, which made
    // crosses('cpu') -- `>= 0.9` -- STRUCTURALLY unable to fire anywhere in a ladder. So
    // "nothing resembling a CPU ceiling was reached" was a restatement of the sampling bug,
    // not a finding. With a real under-load mean the same untouched comparison can fire.
    const idle = analyzeLadder([
      rung({ c: 1, hostCpuFraction: 0.0006 }),
      rung({ c: 2, hostCpuFraction: 0.0006 }),
      rung({ c: 4, hostCpuFraction: 0.0006, p95Ms: 400 }),
    ]);
    expect(idle.bound).not.toBe('cpu');

    const loaded = analyzeLadder([
      enriched({ c: 1, hostCpuFraction: 0.1 }),
      enriched({ c: 2, hostCpuFraction: 0.5 }),
      enriched({ c: 4, hostCpuFraction: 0.95, p95Ms: 400 }),
    ]);
    expect(loaded.bound).toBe('cpu');
  });

  it('ignores postLoadHostCpuFraction entirely: it is the record, not the signal', () => {
    // The idle snapshot is retained under its own name so it can never again pass as an
    // under-load reading. Nothing in this module may read it.
    const r = analyzeLadder([
      enriched({ c: 1, hostCpuFraction: 0.95 }),
      enriched({ c: 2, hostCpuFraction: 0.95 }),
      enriched({ c: 4, hostCpuFraction: 0.95, p95Ms: 400 }),
    ]);
    const alsoIdle = analyzeLadder([
      { ...enriched({ c: 1, hostCpuFraction: 0.95 }), postLoadHostCpuFraction: 0.99 },
      { ...enriched({ c: 2, hostCpuFraction: 0.95 }), postLoadHostCpuFraction: 0.99 },
      { ...enriched({ c: 4, hostCpuFraction: 0.95, p95Ms: 400 }), postLoadHostCpuFraction: 0.99 },
    ]);
    expect(alsoIdle).toEqual(r);
  });

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
});
