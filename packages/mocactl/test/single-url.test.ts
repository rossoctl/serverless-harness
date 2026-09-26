import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdDoctor, type Io } from '../src/headless.js';
import { buildRuntime } from '../src/runtime.js';

// The whole point of discovery: a user gives one URL, and the harness is where the control plane
// says it is. These run the real clients over a fetch that records every URL it is asked for.
function recordingFetch(discovered: unknown) {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    if (url === 'http://cp/v1/discovery') return Response.json({ harnessUrl: discovered });
    if (url.endsWith('/health') || url.endsWith('/healthz')) return new Response('ok');
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

const home = () => mkdtempSync(join(tmpdir(), 'mocactl-one-url-'));
const quietIo = (): Io & { errs: string[] } => {
  const errs: string[] = [];
  return { errs, out: () => undefined, err: (s) => void errs.push(s) };
};

describe('one URL', () => {
  it('reaches the harness the control plane advertises, given only SH_CONTROL_PLANE_URL', async () => {
    const { seen, fetchImpl } = recordingFetch('http://harness.example');
    const rt = buildRuntime({}, { SH_CONTROL_PLANE_URL: 'http://cp' }, home(), fetchImpl);
    await rt.harness!.health();
    expect(seen).toEqual(['http://cp/v1/discovery', 'http://harness.example/health']);
  });

  it('lets a local harness URL override discovery, which is then never asked', async () => {
    const { seen, fetchImpl } = recordingFetch('http://harness.example');
    const rt = buildRuntime(
      {},
      { SH_CONTROL_PLANE_URL: 'http://cp', SH_HARNESS_URL: 'http://local:18081' },
      home(),
      fetchImpl,
    );
    await rt.harness!.health();
    expect(seen).toEqual(['http://local:18081/health']);
  });

  it('runs doctor with no harness URL configured, instead of refusing', async () => {
    const { fetchImpl } = recordingFetch('http://harness.example');
    const rt = buildRuntime({}, { SH_CONTROL_PLANE_URL: 'http://cp' }, home(), fetchImpl);
    const o = quietIo();
    // Not logged in, so doctor stops at check 3 (exit 1) — but it ran: 2 would be a usage refusal.
    expect(await cmdDoctor(rt, o, false)).toBe(1);
    expect(o.errs.join('\n')).not.toContain('harness URL');
  });
});
