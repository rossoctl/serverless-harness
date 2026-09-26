import { ApiError, errorFromResponse, networkError } from './errors.js';
import type {
  ApiLogin,
  ControlPlaneApi,
  CreateSessionRequest,
  CreatedSession,
  CredentialDescriptor,
  DeviceStart,
  Discovery,
  Me,
  PutCredentialRequest,
  SessionPage,
  SessionSummary,
  SessionToken,
} from './types.js';

type Query = Record<string, string | number | undefined>;

export class ControlPlaneClient implements ControlPlaneApi {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly getToken: () => string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  private async request(
    method: string,
    path: string,
    opts: { body?: unknown; auth?: boolean; query?: Query } = {},
  ): Promise<Response> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.auth !== false) {
      const token = this.getToken();
      if (token) headers.authorization = `Bearer ${token}`;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch (err) {
      throw networkError('control-plane', err);
    }
    if (!res.ok) throw await errorFromResponse('control-plane', res);
    return res;
  }

  private async json<T>(
    method: string,
    path: string,
    opts?: { body?: unknown; auth?: boolean; query?: Query },
  ): Promise<T> {
    return (await (await this.request(method, path, opts)).json()) as T;
  }

  async healthz(): Promise<void> {
    await this.request('GET', '/healthz', { auth: false });
  }

  async readyz(): Promise<void> {
    await this.request('GET', '/readyz', { auth: false });
  }

  discovery(): Promise<Discovery> {
    return this.json('GET', '/v1/discovery', { auth: false });
  }

  startDeviceAuth(): Promise<DeviceStart> {
    return this.json('POST', '/v1/auth/device', { auth: false });
  }

  async pollDeviceAuth(deviceCode: string): Promise<ApiLogin | 'pending'> {
    try {
      return await this.json<ApiLogin>('POST', '/v1/auth/device/token', {
        auth: false,
        body: { deviceCode },
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'authorization_pending') return 'pending';
      throw err;
    }
  }

  me(): Promise<Me> {
    return this.json('GET', '/v1/me');
  }

  listSessions(opts: { limit?: number; cursor?: number } = {}): Promise<SessionPage> {
    return this.json('GET', '/v1/sessions', { query: { limit: opts.limit, cursor: opts.cursor } });
  }

  createSession(req: CreateSessionRequest): Promise<CreatedSession> {
    return this.json('POST', '/v1/sessions', { body: req });
  }

  getSession(id: string): Promise<SessionSummary> {
    return this.json('GET', `/v1/sessions/${encodeURIComponent(id)}`);
  }

  async deleteSession(id: string): Promise<'deleted' | 'accepted'> {
    const res = await this.request('DELETE', `/v1/sessions/${encodeURIComponent(id)}`);
    return res.status === 202 ? 'accepted' : 'deleted';
  }

  mintSessionToken(id: string): Promise<SessionToken> {
    return this.json('POST', `/v1/sessions/${encodeURIComponent(id)}/token`);
  }

  async listCredentials(): Promise<CredentialDescriptor[]> {
    return (await this.json<{ credentials: CredentialDescriptor[] }>('GET', '/v1/credentials'))
      .credentials;
  }

  async putCredential(name: string, req: PutCredentialRequest): Promise<void> {
    await this.request('PUT', `/v1/credentials/${encodeURIComponent(name)}`, { body: req });
  }

  async deleteCredential(name: string): Promise<void> {
    await this.request('DELETE', `/v1/credentials/${encodeURIComponent(name)}`);
  }
}
