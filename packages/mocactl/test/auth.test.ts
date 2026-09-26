import { describe, expect, it } from 'vitest';
import {
  LoginCancelledError,
  LoginExpiredError,
  apiTokenValid,
  deviceLogin,
  loginExpiryMinutes,
  toCachedAuth,
} from '../src/core/auth.js';
import { sleep } from '../src/core/time.js';
import { fakeControlPlane } from './helpers/fakes.js';

function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => void (t += ms),
    advance: (ms: number) => (t += ms),
  };
}

const login = {
  token: 'api',
  subject: 'github:1',
  displayName: 'Ada',
  roles: ['user'],
  expiresAt: 3600,
};

describe('deviceLogin', () => {
  it('shows the code, polls at the server interval, and returns the login', async () => {
    const c = clock();
    const polls: number[] = [];
    let n = 0;
    const cp = fakeControlPlane({
      pollDeviceAuth: async () => (polls.push(c.now()), ++n < 3 ? 'pending' : login),
    });
    const shown: string[] = [];
    const result = await deviceLogin({ cp, ...c }, (s) => shown.push(s.userCode));
    expect(result).toEqual(login);
    expect(shown).toEqual(['ABCD-1234']);
    expect(polls).toEqual([5000, 10000, 15000]);
  });

  it('gives up with LoginExpiredError after expiresIn', async () => {
    const c = clock();
    const cp = fakeControlPlane({
      startDeviceAuth: async () => ({
        deviceCode: 'd',
        userCode: 'U',
        verificationUri: 'v',
        interval: 5,
        expiresIn: 12,
      }),
    });
    await expect(deviceLogin({ cp, ...c }, () => undefined)).rejects.toBeInstanceOf(
      LoginExpiredError,
    );
  });

  it('stops with LoginCancelledError when aborted', async () => {
    const ac = new AbortController();
    const c = clock();
    const cp = fakeControlPlane();
    const p = deviceLogin(
      {
        cp,
        now: c.now,
        sleep: async (ms) => {
          c.advance(ms);
          ac.abort();
        },
      },
      () => undefined,
      ac.signal,
    );
    await expect(p).rejects.toBeInstanceOf(LoginCancelledError);
  });

  it('propagates a real error from the poll', async () => {
    const c = clock();
    const cp = fakeControlPlane({
      pollDeviceAuth: async () => {
        throw new Error('access_denied');
      },
    });
    await expect(deviceLogin({ cp, ...c }, () => undefined)).rejects.toThrow('access_denied');
  });
});

describe('cached auth helpers', () => {
  const auth = toCachedAuth(login, 'http://cp');

  it('maps a login to the cache shape', () => {
    expect(auth).toEqual({
      apiToken: 'api',
      subject: 'github:1',
      displayName: 'Ada',
      roles: ['user'],
      expiresAt: 3600,
      controlPlaneUrl: 'http://cp',
    });
  });

  it('treats an expired or missing token as invalid', () => {
    expect(apiTokenValid(auth, 3_599_000)).toBe(true);
    expect(apiTokenValid(auth, 3_600_000)).toBe(false);
    expect(apiTokenValid(null, 0)).toBe(false);
  });

  it('warns only in the last five minutes', () => {
    expect(loginExpiryMinutes(auth, 3_000_000)).toBeUndefined();
    expect(loginExpiryMinutes(auth, 3_361_000)).toBe(4);
    expect(loginExpiryMinutes(auth, 3_600_000)).toBeUndefined();
  });
});

describe('sleep', () => {
  it('resolves early when aborted', async () => {
    const ac = new AbortController();
    const started = Date.now();
    const p = sleep(10_000, ac.signal);
    ac.abort();
    await p;
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
