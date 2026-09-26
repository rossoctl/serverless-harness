import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi, type Mock } from 'vitest';
import { DEFAULT_CONFIG, resolvePaths } from '../../src/config.js';
import { TranscriptStore } from '../../src/core/transcripts.js';
import type { OsDeps } from '../../src/os.js';
import type { Runtime } from '../../src/runtime.js';
import { credential, fakeControlPlane, fakeHarness } from './fakes.js';

export function testRuntime(over: Partial<Runtime> = {}): Runtime {
  const paths = resolvePaths({}, mkdtempSync(join(tmpdir(), 'mocactl-app-')));
  const auth = {
    apiToken: 'a',
    subject: 'github:1',
    displayName: 'Ada',
    roles: [],
    expiresAt: 4_000_000_000,
    controlPlaneUrl: 'http://cp',
  };
  return {
    paths,
    config: { ...DEFAULT_CONFIG, controlPlaneUrl: 'http://cp', harnessUrl: 'http://h' },
    configExists: true,
    endpoints: { controlPlaneUrl: 'http://cp', harnessUrl: 'http://h' },
    auth,
    cp: fakeControlPlane({ listCredentials: async () => [credential('anthropic')] }),
    harness: fakeHarness([]),
    transcripts: new TranscriptStore(paths.transcriptsDir, {
      subject: auth.subject,
      controlPlaneUrl: 'http://cp',
    }),
    now: () => 1_000_000_000_000,
    // A macrotask, not a resolved promise: the device-login poll loop awaits this between polls,
    // and an instantly-resolving sleep would spin it on microtasks forever and starve every timer.
    sleep: () => new Promise<void>((r) => setTimeout(r, 5)),
    fetchImpl: fetch,
    ...over,
  };
}

export function fakeOs(): OsDeps & {
  copy: Mock;
  openUrl: Mock;
  editText: Mock;
  openInEditor: Mock;
} {
  return {
    copy: vi.fn(async () => undefined),
    openUrl: vi.fn(),
    editText: vi.fn(() => 'from the editor'),
    openInEditor: vi.fn(),
  };
}
