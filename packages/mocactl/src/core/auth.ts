import type { ApiLogin, ControlPlaneApi, DeviceStart } from '../api/types.js';
import type { CachedAuth } from '../config.js';

export class LoginCancelledError extends Error {
  constructor() {
    super('login cancelled');
    this.name = 'LoginCancelledError';
  }
}

export class LoginExpiredError extends Error {
  constructor() {
    super('the login code expired before it was approved — start again');
    this.name = 'LoginExpiredError';
  }
}

export interface LoginDeps {
  cp: Pick<ControlPlaneApi, 'startDeviceAuth' | 'pollDeviceAuth'>;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
}

export async function deviceLogin(
  deps: LoginDeps,
  onCode: (start: DeviceStart) => void,
  signal?: AbortSignal,
): Promise<ApiLogin> {
  const start = await deps.cp.startDeviceAuth();
  onCode(start);
  const deadline = deps.now() + start.expiresIn * 1000;
  const interval = Math.max(1, start.interval) * 1000;
  for (;;) {
    await deps.sleep(interval, signal);
    if (signal?.aborted) throw new LoginCancelledError();
    if (deps.now() > deadline) throw new LoginExpiredError();
    const result = await deps.cp.pollDeviceAuth(start.deviceCode);
    if (result !== 'pending') return result;
  }
}

export function toCachedAuth(login: ApiLogin, controlPlaneUrl: string): CachedAuth {
  return {
    apiToken: login.token,
    subject: login.subject,
    displayName: login.displayName,
    roles: login.roles ?? [],
    expiresAt: login.expiresAt,
    controlPlaneUrl,
  };
}

export function apiTokenValid(auth: CachedAuth | null, nowMs: number): boolean {
  return !!auth && auth.expiresAt * 1000 > nowMs;
}

export function loginExpiryMinutes(auth: CachedAuth | null, nowMs: number): number | undefined {
  if (!auth) return undefined;
  const leftMs = auth.expiresAt * 1000 - nowMs;
  if (leftMs <= 0 || leftMs >= 5 * 60_000) return undefined;
  return Math.ceil(leftMs / 60_000);
}
