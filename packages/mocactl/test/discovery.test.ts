import { describe, expect, it } from 'vitest';
import { DiscoveringHarness, discoverHarnessUrl } from '../src/api/discovery.js';
import { ApiError } from '../src/api/errors.js';
import { fakeControlPlane } from './helpers/fakes.js';

const codeOf = async (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (err: unknown) => (err instanceof ApiError ? err.code : String(err)),
  );

describe('discoverHarnessUrl', () => {
  it('returns the advertised URL without trailing slashes', async () => {
    const cp = fakeControlPlane({
      discovery: async () => ({ harnessUrl: 'https://h.example/base/' }),
    });
    expect(await discoverHarnessUrl(cp)).toBe('https://h.example/base');
  });

  it('tells a control plane that predates discovery (404) from one that advertises nothing', async () => {
    const old = fakeControlPlane({
      discovery: async () => {
        throw new ApiError('control-plane', 404, 'not_found');
      },
    });
    const unset = fakeControlPlane({ discovery: async () => ({ harnessUrl: null }) });
    expect(await codeOf(discoverHarnessUrl(old))).toBe('discovery_unsupported');
    expect(await codeOf(discoverHarnessUrl(unset))).toBe('harness_unadvertised');
    await discoverHarnessUrl(unset).catch((err: Error) => {
      expect(err.message).toContain('SH_PUBLIC_HARNESS_URL');
      expect(err.message).toContain('--harness-url');
    });
  });

  it('refuses a non-http(s) or non-string URL and never echoes it', async () => {
    for (const harnessUrl of ['javascript:alert(1)', 'not a url', 42, { x: 1 }]) {
      const cp = fakeControlPlane({ discovery: async () => ({ harnessUrl }) as never });
      const err = await discoverHarnessUrl(cp).catch((e: ApiError) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('harness_unadvertised');
      expect((err as ApiError).message).not.toContain(String(harnessUrl));
    }
  });

  it('serialises the URL through the parser, so no control character survives', async () => {
    const cp = fakeControlPlane({
      discovery: async () => ({ harnessUrl: 'https://h.example/a\u001b]52;c;x\u0007b' }),
    });
    expect(await discoverHarnessUrl(cp)).not.toMatch(/[\u0000-\u001f]/);
  });

  it('passes a connection failure through untouched', async () => {
    const cp = fakeControlPlane({
      discovery: async () => {
        throw new ApiError('control-plane', 0, 'network_error', 'ECONNREFUSED');
      },
    });
    expect(await codeOf(discoverHarnessUrl(cp))).toBe('network_error');
  });
});

describe('DiscoveringHarness', () => {
  const okFetch = (seen: string[]) =>
    (async (url: string | URL) => {
      seen.push(String(url));
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

  it('asks once, then sends every request to the discovered URL', async () => {
    let asked = 0;
    const seen: string[] = [];
    const h = new DiscoveringHarness(async () => {
      asked++;
      return 'http://found';
    }, okFetch(seen));
    await h.health();
    await h.health();
    expect(await h.baseUrl()).toBe('http://found');
    expect(asked).toBe(1);
    expect(seen).toEqual(['http://found/health', 'http://found/health']);
  });

  it('does not cache a failure, so fixing the deployment needs no restart', async () => {
    let fixed = false;
    const h = new DiscoveringHarness(async () => {
      if (!fixed) throw new ApiError('control-plane', 404, 'harness_unadvertised');
      return 'http://found';
    }, okFetch([]));
    expect(await codeOf(h.health())).toBe('harness_unadvertised');
    fixed = true;
    expect(await h.baseUrl()).toBe('http://found');
  });

  it('treats a cancel during discovery as a cancelled turn, sending nothing', async () => {
    const seen: string[] = [];
    const ac = new AbortController();
    const h = new DiscoveringHarness(async () => {
      ac.abort();
      return 'http://found';
    }, okFetch(seen));
    const turn = h.streamTurn({ sessionId: 's', prompt: 'p', token: 't', signal: ac.signal });
    await expect(turn.next()).rejects.toThrow('turn cancelled');
    expect(seen).toEqual([]);
  });
});
