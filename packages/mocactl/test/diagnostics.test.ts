import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/errors.js';
import {
  DIAGNOSTIC_NAMES,
  formatDiagnostics,
  runDiagnostics,
  type DiagnosticsDeps,
} from '../src/core/diagnostics.js';
import { credential, fakeControlPlane, fakeHarness } from './helpers/fakes.js';

const deps = (over: Partial<DiagnosticsDeps> = {}): DiagnosticsDeps => ({
  cp: fakeControlPlane({ listCredentials: async () => [credential('anthropic')] }),
  harness: fakeHarness([]),
  controlPlaneUrl: 'http://cp',
  harnessUrl: 'http://h',
  loggedIn: true,
  ...over,
});

describe('runDiagnostics', () => {
  it('passes all six checks on a healthy setup and deletes the scratch session', async () => {
    const d = deps();
    const results = await runDiagnostics(d);
    expect(results.map((r) => r.status)).toEqual(Array(6).fill('pass'));
    expect(results.map((r) => r.name)).toEqual([...DIAGNOSTIC_NAMES]);
    const calls = (d.cp as unknown as { calls: string[] }).calls;
    expect(calls).toContain('createSession');
    expect(calls).toContain('deleteSession');
  });

  it('stops at the first failure with a fix naming the URL', async () => {
    const d = deps({
      cp: fakeControlPlane({
        healthz: async () => {
          throw new ApiError('control-plane', 0, 'network_error', 'ECONNREFUSED');
        },
      }),
    });
    const results = await runDiagnostics(d);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 1, status: 'fail', detail: 'ECONNREFUSED' });
    expect(results[0].fix).toContain('http://cp');
  });

  it('fails the login check without calling /v1/me when there is no cached login', async () => {
    const d = deps({ loggedIn: false });
    const results = await runDiagnostics(d);
    expect(results.at(-1)).toMatchObject({ id: 3, status: 'fail' });
    expect((d.cp as unknown as { calls: string[] }).calls).not.toContain('me');
  });

  it('fails check 4 when only non-inference credentials exist', async () => {
    const results = await runDiagnostics(
      deps({
        cp: fakeControlPlane({
          listCredentials: async () => [credential('gh', { consumer: 'sandbox-egress' })],
        }),
      }),
    );
    expect(results.at(-1)).toMatchObject({ id: 4, status: 'fail' });
    expect(results.at(-1)!.fix).toMatch(/\/credentials/);
  });

  it('reports an untrusted harness with the settings it needs, and still cleans up', async () => {
    const d = deps({ harness: fakeHarness([], { probeTrust: async () => 'untrusted' }) });
    const results = await runDiagnostics(d);
    expect(results.at(-1)).toMatchObject({ id: 6, status: 'fail' });
    expect(results.at(-1)!.fix).toContain('SH_SESSION_TOKEN_PUBLIC_KEYS');
    expect((d.cp as unknown as { calls: string[] }).calls).toContain('deleteSession');
  });

  it('cleans up the scratch session even when the probe throws', async () => {
    const d = deps({
      harness: fakeHarness([], {
        probeTrust: async () => {
          throw new Error('boom');
        },
      }),
    });
    const results = await runDiagnostics(d);
    expect(results.at(-1)).toMatchObject({ id: 6, status: 'fail', detail: 'boom' });
    expect((d.cp as unknown as { calls: string[] }).calls).toContain('deleteSession');
  });
});

describe('formatDiagnostics', () => {
  it('renders one line per check', () => {
    expect(
      formatDiagnostics([
        { id: 1, name: 'control plane reachable', status: 'pass' },
        { id: 2, name: 'control plane ready', status: 'fail', fix: 'start Redis' },
      ]),
    ).toBe('✓ 1 control plane reachable\n✗ 2 control plane ready — start Redis');
  });
});
