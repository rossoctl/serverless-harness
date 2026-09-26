import { describe, expect, it } from 'vitest';
import { HANDLERS } from '../src/handlers.js';
import { ctx, makeDeps } from './helpers/deps.js';

describe('GET /v1/discovery', () => {
  it('advertises the configured harness URL', async () => {
    const d = makeDeps({ config: { publicHarnessUrl: 'https://harness.example.com' } });
    expect(await HANDLERS.getDiscovery!(ctx({}), d)).toEqual({
      status: 200,
      body: { harnessUrl: 'https://harness.example.com' },
    });
  });

  it('answers null rather than 404 when the deployment advertises none', async () => {
    // A 404 is how a client recognises a control plane that predates discovery; null is a
    // deployment that has it but was not given SH_PUBLIC_HARNESS_URL. They need different fixes.
    expect(await HANDLERS.getDiscovery!(ctx({}), makeDeps())).toEqual({
      status: 200,
      body: { harnessUrl: null },
    });
  });
});
