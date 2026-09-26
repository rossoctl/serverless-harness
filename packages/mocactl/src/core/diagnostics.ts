import type { ControlPlaneApi, HarnessApi } from '../api/types.js';

export interface CheckResult {
  id: number;
  name: string;
  status: 'pass' | 'fail';
  fix?: string;
  detail?: string;
}

export interface DiagnosticsDeps {
  cp: ControlPlaneApi;
  harness: HarnessApi;
  controlPlaneUrl: string;
  harnessUrl: string;
  loggedIn: boolean;
}

export const DIAGNOSTIC_NAMES = [
  'control plane reachable',
  'control plane ready',
  'logged in',
  'inference credential present',
  'harness reachable',
  'harness trusts this control plane',
] as const;

const MU1_HARNESS_SETTINGS =
  'SH_SESSION_TOKEN_PUBLIC_KEYS (and, on the VM path, SH_CONTROL_PLANE_URL, SH_EXCHANGE_TOKEN and SH_REQUIRE_AUTH)';

/** Spec §6.9: dependency-ordered checks, each failure ending in one line saying what to do. */
export async function runDiagnostics(deps: DiagnosticsDeps): Promise<CheckResult[]> {
  let credential: string | undefined;
  const checks: Array<{ run: () => Promise<void>; fix: string }> = [
    {
      run: () => deps.cp.healthz(),
      fix: `cannot reach the control plane at ${deps.controlPlaneUrl} — check --control-plane-url`,
    },
    {
      run: () => deps.cp.readyz(),
      fix: 'the control plane is up but its session store (Redis) is down',
    },
    {
      run: async () => {
        if (!deps.loggedIn) throw new Error('no cached login');
        await deps.cp.me();
      },
      fix: 'not logged in — run `mocactl login`, or start `mocactl` to log in',
    },
    {
      run: async () => {
        credential = (await deps.cp.listCredentials()).find(
          (c) => c.consumer === 'inference',
        )?.name;
        if (!credential) throw new Error('no credential with consumer "inference"');
      },
      fix: 'no inference credential — add one with /credentials',
    },
    {
      run: () => deps.harness.health(),
      fix: `cannot reach the harness at ${deps.harnessUrl} — check --harness-url`,
    },
    {
      // A scratch session, because a session token must name one. The probe never runs a model
      // turn (HarnessClient.probeTrust), and the session is deleted whatever happens.
      run: async () => {
        const s = await deps.cp.createSession({ credentials: { inference: credential } });
        try {
          if ((await deps.harness.probeTrust(s.token, s.sessionId)) === 'untrusted') {
            throw new Error('the harness rejected a valid session token');
          }
        } finally {
          await deps.cp.deleteSession(s.sessionId).catch(() => undefined);
        }
      },
      fix: `the harness does not trust this control plane's tokens — it needs ${MU1_HARNESS_SETTINGS}`,
    },
  ];

  const results: CheckResult[] = [];
  for (const [i, check] of checks.entries()) {
    const base = { id: i + 1, name: DIAGNOSTIC_NAMES[i] };
    try {
      await check.run();
      results.push({ ...base, status: 'pass' });
    } catch (err) {
      results.push({
        ...base,
        status: 'fail',
        fix: check.fix,
        detail: err instanceof Error ? err.message : String(err),
      });
      break;
    }
  }
  return results;
}

export function formatDiagnostics(results: CheckResult[]): string {
  return results
    .map((r) => (r.status === 'pass' ? `✓ ${r.id} ${r.name}` : `✗ ${r.id} ${r.name} — ${r.fix}`))
    .join('\n');
}
