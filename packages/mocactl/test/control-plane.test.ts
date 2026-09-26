import { describe, expect, it } from 'vitest';
import { ControlPlaneClient } from '../src/api/control-plane.js';
import { ApiError } from '../src/api/errors.js';
import { json, scriptedFetch } from './helpers/fake-fetch.js';

const client = (f: typeof fetch, token = 'api-tok') =>
  new ControlPlaneClient('http://cp', () => token, f);

describe('ControlPlaneClient', () => {
  it('sends the API token as a bearer on /v1 calls', async () => {
    const { fetch, calls } = scriptedFetch(json({ subject: 'github:1', tenant: 't', roles: [] }));
    await client(fetch).me();
    expect(calls[0]).toMatchObject({ url: 'http://cp/v1/me', method: 'GET' });
    expect(calls[0].headers.authorization).toBe('Bearer api-tok');
  });

  it('sends no bearer on the unauthenticated device-flow calls', async () => {
    const { fetch, calls } = scriptedFetch(
      json({
        deviceCode: 'd',
        userCode: 'U',
        verificationUri: 'https://gh',
        interval: 5,
        expiresIn: 900,
      }),
    );
    await client(fetch).startDeviceAuth();
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[0]).toMatchObject({ url: 'http://cp/v1/auth/device', method: 'POST' });
  });

  it('keeps a path prefix and drops a trailing slash', async () => {
    const { fetch, calls } = scriptedFetch(json({ subject: 's', tenant: 't', roles: [] }));
    await new ControlPlaneClient('https://gw.example/cp/', () => 't', fetch).me();
    expect(calls[0].url).toBe('https://gw.example/cp/v1/me');
  });

  it('maps 428 on the device poll to "pending"', async () => {
    const { fetch, calls } = scriptedFetch(json({ error: 'authorization_pending' }, 428));
    expect(await client(fetch).pollDeviceAuth('d')).toBe('pending');
    expect(calls[0].body).toEqual({ deviceCode: 'd' });
  });

  it('passes list paging as query parameters', async () => {
    const { fetch, calls } = scriptedFetch(json({ sessions: [], nextCursor: null }));
    await client(fetch).listSessions({ limit: 20, cursor: 123 });
    expect(calls[0].url).toBe('http://cp/v1/sessions?limit=20&cursor=123');
  });

  it('encodes ids in paths', async () => {
    const { fetch, calls } = scriptedFetch(json({ token: 'st', expiresAt: 10 }));
    await client(fetch).mintSessionToken('a/b');
    expect(calls[0]).toMatchObject({ url: 'http://cp/v1/sessions/a%2Fb/token', method: 'POST' });
  });

  it('distinguishes a 202 delete from a 204 delete', async () => {
    const { fetch } = scriptedFetch(
      new Response(null, { status: 202 }),
      new Response(null, { status: 204 }),
    );
    const c = client(fetch);
    expect(await c.deleteSession('s1')).toBe('accepted');
    expect(await c.deleteSession('s2')).toBe('deleted');
  });

  it('unwraps the credentials list and PUTs a credential body', async () => {
    const cred = {
      name: 'a',
      kind: 'bearer',
      consumer: 'inference',
      destination: { hosts: [] },
      binding: { header: 'Authorization', format: 'Bearer {token}' },
      endpoint: 'https://gw',
    };
    const { fetch, calls } = scriptedFetch(
      json({ credentials: [cred] }),
      new Response(null, { status: 204 }),
    );
    const c = client(fetch);
    expect(await c.listCredentials()).toEqual([cred]);
    await c.putCredential('a', {
      kind: 'bearer',
      consumer: 'inference',
      destination: { hosts: [] },
      secret: { token: 'x' },
    });
    expect(calls[1]).toMatchObject({ url: 'http://cp/v1/credentials/a', method: 'PUT' });
    expect(calls[1].body.secret).toEqual({ token: 'x' });
  });

  it('throws a typed ApiError for an error response', async () => {
    const { fetch } = scriptedFetch(
      json({ error: 'credential_ambiguous', message: 'pick one' }, 400),
    );
    const err = await client(fetch)
      .createSession({})
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      source: 'control-plane',
      status: 400,
      code: 'credential_ambiguous',
    });
  });

  it('turns a fetch rejection into a network ApiError', async () => {
    const { fetch } = scriptedFetch(new TypeError('fetch failed'));
    const err = await client(fetch)
      .healthz()
      .catch((e) => e);
    expect(err).toMatchObject({ status: 0, code: 'network_error', source: 'control-plane' });
  });
});
