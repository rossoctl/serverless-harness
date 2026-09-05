// harness/test/pool-live-smoke.test.ts
import { describe, it, expect } from 'vitest';
import { RedisLeaseStore, leaseKey } from '../src/sandbox-lease.js';

// Gate: only runs with a live Redis (docker) and POOL_LIVE_SMOKE=1.
const live = process.env.POOL_LIVE_SMOKE === '1';
const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

describe.skipIf(!live)('RedisLeaseStore (live redis)', () => {
  it('enforces the soft cap and reclaims expired leases', async () => {
    const pod = `smoke-${process.pid}`;
    // Controllable clock so we can expire a lease deterministically.
    let now = 1_000_000;
    const store = new RedisLeaseStore(url, () => now);
    try {
      // Fresh key. Bracket access reaches the private client for test cleanup only -- TS
      // permits that deliberately, so this needs no @ts-expect-error (it carried one until
      // #190, which tsc then reported as unused once harness/test was checked).
      await store['client'].del(leaseKey(pod));

      expect(await store.acquire(pod, 2, 'a', 1000)).toBe(true);
      expect(await store.acquire(pod, 2, 'b', 1000)).toBe(true);
      expect(await store.acquire(pod, 2, 'c', 1000)).toBe(false); // at cap
      expect(await store.load(pod)).toBe(2);

      now += 2000; // both leases expire
      expect(await store.acquire(pod, 2, 'c', 1000)).toBe(true); // reclaimed slot
      expect(await store.load(pod)).toBe(1);
    } finally {
      await store.release(pod, 'c');
      await store.close();
    }
  });
});
