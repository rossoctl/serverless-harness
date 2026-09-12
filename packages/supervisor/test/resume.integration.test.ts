import { describe, it, expect } from 'vitest';
import { RedisSessionBackend } from '@sh/session-backend';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

describe('session survives the worker that started it', () => {
  it('a second worker reads the state the first one wrote', async () => {
    // The supervisor is process-level, and §6 accepts that a worker crash kills its in-flight
    // turns. What must NOT be lost is the session: it lives in Redis, exactly as it does when
    // a pod is evicted. Same property, new failure mode.
    const a = new RedisSessionBackend<{ role: string; content: string }>(REDIS_URL);
    const b = new RedisSessionBackend<{ role: string; content: string }>(REDIS_URL);
    const sid = `p6-resume-${process.pid}-${Date.now()}`;
    try {
      await a.append(sid, { role: 'user', content: 'first turn' }, 'message');
      // "Worker A dies here." Nothing about the state is worker-local.
      await a.close();
      const restored = await b.read(sid);
      expect(restored.map((m) => m.entry.content)).toContain('first turn');
      await b.append(sid, { role: 'user', content: 'second turn' }, 'message');
      expect((await b.read(sid)).length).toBe(2);
    } finally {
      // reset() needs a live client, so it must run before close() tears the connection down.
      await b.reset(sid).catch(() => {});
      await b.close().catch(() => {});
    }
  });
});
