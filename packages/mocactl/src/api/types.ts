import type { TurnFrame } from './frames.js';

// Mirrors docs/api/openapi.yaml; test/contract.test.ts holds the two together (spec §7.4).
export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

export interface ApiLogin {
  token: string;
  subject: string;
  displayName?: string;
  roles?: string[];
  expiresAt: number;
}

export interface Me {
  subject: string;
  tenant: string;
  roles: string[];
}

export interface SessionSummary {
  sessionId: string;
  owner: string;
  tenant: string;
  createdAt: number;
  state: 'active' | 'deleting';
  lastTurnAt: number | null;
  turns: number;
}

export interface SessionPage {
  sessions: SessionSummary[];
  nextCursor: number | null;
}

export interface CreateSessionRequest {
  credentials?: { inference?: string };
}

export interface SessionToken {
  token: string;
  expiresAt: number;
}

export interface CreatedSession extends SessionToken {
  sessionId: string;
}

export type CredentialConsumer = 'inference' | 'sandbox-egress' | 'control-plane';

export interface CredentialDescriptor {
  name: string;
  kind: string;
  consumer: CredentialConsumer;
  destination: { hosts: string[] };
  binding: { header: string; format: string };
  endpoint?: string | null;
}

export interface PutCredentialRequest {
  kind: string;
  consumer: CredentialConsumer;
  destination: { hosts: string[] };
  binding?: { header: string; format: string };
  endpoint?: string | null;
  secret: Record<string, string>;
}

/** GET /v1/discovery: where the rest of the deployment is, readable before login. */
export interface Discovery {
  harnessUrl: string | null;
}

export interface ControlPlaneApi {
  healthz(): Promise<void>;
  readyz(): Promise<void>;
  discovery(): Promise<Discovery>;
  startDeviceAuth(): Promise<DeviceStart>;
  pollDeviceAuth(deviceCode: string): Promise<ApiLogin | 'pending'>;
  me(): Promise<Me>;
  listSessions(opts?: { limit?: number; cursor?: number }): Promise<SessionPage>;
  createSession(req: CreateSessionRequest): Promise<CreatedSession>;
  getSession(id: string): Promise<SessionSummary>;
  deleteSession(id: string): Promise<'deleted' | 'accepted'>;
  mintSessionToken(id: string): Promise<SessionToken>;
  listCredentials(): Promise<CredentialDescriptor[]>;
  putCredential(name: string, req: PutCredentialRequest): Promise<void>;
  deleteCredential(name: string): Promise<void>;
}

export interface StreamTurnArgs {
  sessionId: string;
  prompt: string;
  token: string;
  signal?: AbortSignal;
}

export interface HarnessApi {
  /** The base URL turns go to; for a discovered harness this asks the control plane first. */
  baseUrl(): Promise<string>;
  health(): Promise<void>;
  streamTurn(args: StreamTurnArgs): AsyncGenerator<TurnFrame>;
  probeTrust(token: string, sessionId: string): Promise<'trusted' | 'untrusted'>;
}
