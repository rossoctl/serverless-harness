import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadAuth, resolvePaths } from '../src/config.js';
import { HarnessUntrustedError } from '../src/core/session-manager.js';
import { cmdDoctor, cmdLogin, cmdRun, type Io } from '../src/headless.js';
import type { Runtime } from '../src/runtime.js';
import { ApiError } from '../src/api/errors.js';
import { credential, doneFrame, fakeControlPlane, fakeHarness } from './helpers/fakes.js';

function io(): Io & { stdout: string; stderr: string[] } {
  const o = {
    stdout: '',
    stderr: [] as string[],
    out: (s: string) => void (o.stdout += s),
    err: (s: string) => void o.stderr.push(s),
  };
  return o;
}

function runtime(over: Partial<Runtime> = {}): Runtime {
  const paths = resolvePaths({}, mkdtempSync(join(tmpdir(), 'mocactl-rt-')));
  return {
    paths,
    config: { ...DEFAULT_CONFIG },
    configExists: true,
    endpoints: { controlPlaneUrl: 'http://cp', harnessUrl: 'http://h' },
    auth: {
      apiToken: 'a',
      subject: 'github:1',
      roles: [],
      expiresAt: 4_000_000_000,
      controlPlaneUrl: 'http://cp',
    },
    cp: fakeControlPlane({ listCredentials: async () => [credential('anthropic')] }),
    harness: fakeHarness([
      {
        frames: [
          { type: 'text', delta: 'Hello' },
          { type: 'text', delta: ' world' },
          doneFrame('s-new'),
        ],
      },
    ]),
    now: () => 1_000_000_000_000,
    sleep: async () => undefined,
    fetchImpl: fetch,
    ...over,
  };
}

describe('cmdRun', () => {
  it('streams text to stdout and exits 0', async () => {
    const o = io();
    expect(await cmdRun(runtime(), o, { prompt: 'hi', options: {}, json: false })).toBe(0);
    expect(o.stdout).toBe('Hello world\n');
    expect(o.stderr).toContain('session s-new');
  });

  it('emits newline-delimited frames with --json, starting with the session', async () => {
    const o = io();
    await cmdRun(runtime(), o, { prompt: 'hi', options: {}, json: true });
    const lines = o.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({ type: 'session', sessionId: 's-new' });
    expect(lines.map((l) => l.type)).toEqual(['session', 'text', 'text', 'done']);
  });

  it('asks for --option when several inference credentials exist', async () => {
    const o = io();
    const rt = runtime({
      cp: fakeControlPlane({ listCredentials: async () => [credential('a'), credential('b')] }),
    });
    expect(await cmdRun(rt, o, { prompt: 'hi', options: {}, json: false })).toBe(2);
    expect(o.stderr.join('\n')).toContain('--option inferenceCredential=<value>: a, b');
  });

  it('uses the credential named with --option', async () => {
    let asked: unknown;
    const rt = runtime({
      cp: fakeControlPlane({
        listCredentials: async () => [credential('a'), credential('b')],
        createSession: async (req) => (
          (asked = req),
          { sessionId: 's-new', token: 'st', expiresAt: 4_000_000_000 }
        ),
      }),
    });
    expect(
      await cmdRun(rt, io(), { prompt: 'hi', options: { inferenceCredential: 'b' }, json: false }),
    ).toBe(0);
    expect(asked).toEqual({ credentials: { inference: 'b' } });
  });

  it('is blocked with a hint when there is no inference credential', async () => {
    const o = io();
    expect(
      await cmdRun(runtime({ cp: fakeControlPlane() }), o, {
        prompt: 'hi',
        options: {},
        json: false,
      }),
    ).toBe(2);
    expect(o.stderr.join('\n')).toContain('add an inference credential to start');
  });

  it('refuses to run without a valid login', async () => {
    const o = io();
    expect(
      await cmdRun(runtime({ auth: null }), o, { prompt: 'hi', options: {}, json: false }),
    ).toBe(2);
    expect(o.stderr.join('\n')).toMatch(/not logged in/);
  });

  it('resumes an existing session with --session', async () => {
    const rt = runtime();
    await cmdRun(rt, io(), { prompt: 'hi', session: 's1', options: {}, json: false });
    const calls = (rt.cp as unknown as { calls: string[] }).calls;
    expect(calls).toContain('mintSessionToken');
    expect(calls).not.toContain('createSession');
  });

  it('strips escape sequences from reply text written to the terminal', async () => {
    const o = io();
    const rt = runtime({
      harness: fakeHarness([
        {
          frames: [
            { type: 'text', delta: 'a\u001b]52;c;' },
            { type: 'text', delta: 'c2VjcmV0\u0007b' },
            doneFrame('s-new'),
          ],
        },
      ]),
    });
    expect(await cmdRun(rt, o, { prompt: 'hi', options: {}, json: false })).toBe(0);
    expect(o.stdout).not.toMatch(/[\u0007\u001b]/);
    expect(o.stdout).toMatch(/^a.*b\n$/); // a split sequence leaves printable residue only
  });

  it('exits 1 with a readable message when the turn fails', async () => {
    const o = io();
    const bad = new ApiError('harness', 401, 'token_invalid');
    const rt = runtime({ harness: fakeHarness([{ error: bad }, { error: bad }]) });
    expect(await cmdRun(rt, o, { prompt: 'hi', options: {}, json: false })).toBe(1);
    expect(o.stderr).toContain(new HarnessUntrustedError().message);
    // Headless, the fix is a command the user can run from this shell, not a slash command.
    expect(o.stderr.join('\n')).toContain('`mocactl doctor`');
  });

  it('exits 130 when cancelled', async () => {
    const ac = new AbortController();
    const rt = runtime({ harness: fakeHarness([{ hang: true }]) });
    const p = cmdRun(rt, io(), { prompt: 'hi', options: {}, json: false, signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    expect(await p).toBe(130);
  });

  it('exits 130 without running a turn when cancelled during session setup', async () => {
    const ac = new AbortController();
    const harness = fakeHarness([{ frames: [doneFrame('s-new')] }]);
    const rt = runtime({
      cp: fakeControlPlane({
        listCredentials: async () => [credential('anthropic')],
        createSession: async () => {
          ac.abort();
          return { sessionId: 's-new', token: 'st', expiresAt: 4_000_000_000 };
        },
      }),
      harness,
    });
    expect(
      await cmdRun(rt, io(), { prompt: 'hi', options: {}, json: false, signal: ac.signal }),
    ).toBe(130);
    expect(harness.turns).toEqual([]);
  });
});

describe('cmdDoctor', () => {
  it('prints the checks and exits 0 when all pass', async () => {
    const o = io();
    expect(await cmdDoctor(runtime(), o, false)).toBe(0);
    expect(o.stdout.trim().split('\n')).toHaveLength(7);
  });

  it('exits 1 and prints JSON on failure with --json', async () => {
    const o = io();
    expect(await cmdDoctor(runtime({ auth: null }), o, true)).toBe(1);
    expect(JSON.parse(o.stdout).at(-1)).toMatchObject({ id: 3, status: 'fail' });
  });
});

describe('cmdLogin', () => {
  it('prints the code, stores the login, and exits 0', async () => {
    const o = io();
    const rt = runtime({
      auth: null,
      cp: fakeControlPlane({
        pollDeviceAuth: async () => ({
          token: 'new-api',
          subject: 'github:9',
          roles: [],
          expiresAt: 4_000_000_000,
        }),
      }),
    });
    expect(await cmdLogin(rt, o)).toBe(0);
    expect(o.stderr[0]).toContain('ABCD-1234');
    expect(loadAuth(rt.paths, 'http://cp')?.apiToken).toBe('new-api');
    expect(rt.transcripts).toBeDefined();
  });

  it('exits 2 without a control-plane URL', async () => {
    expect(await cmdLogin(runtime({ cp: undefined, endpoints: {} }), io())).toBe(2);
  });

  it('strips escape sequences from the code and URL printed to stderr', async () => {
    const o = io();
    const hostileCode = 'ABCD\u001b[8m-1234';
    const hostileUri = 'https://github.com\u001b]52;c;ZXZpbA==\u0007/login/device';
    const rt = runtime({
      auth: null,
      cp: fakeControlPlane({
        startDeviceAuth: async () => ({
          deviceCode: 'd',
          userCode: hostileCode,
          verificationUri: hostileUri,
          interval: 5,
          expiresIn: 900,
        }),
        pollDeviceAuth: async () => ({
          token: 'new-api',
          subject: 'github:9',
          roles: [],
          expiresAt: 4_000_000_000,
        }),
      }),
    });
    expect(await cmdLogin(rt, o)).toBe(0);
    expect(o.stderr[0]).not.toMatch(/[\u0007\u001b]/);
    expect(o.stderr[0]).toContain('https://github.com/login/device');
    expect(o.stderr[0]).toContain('ABCD-1234');
  });

  it('exits 130 quietly when cancelled during the device-flow poll', async () => {
    const ac = new AbortController();
    const o = io();
    const rt = runtime({
      auth: null,
      sleep: async () => {
        ac.abort();
      },
    });
    expect(await cmdLogin(rt, o, ac.signal)).toBe(130);
    expect(o.stderr.join('\n')).not.toContain('login failed');
  });
});
