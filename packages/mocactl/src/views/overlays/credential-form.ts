import type { CredentialConsumer, PutCredentialRequest } from '../../api/types.js';
import type { FormField } from '../Form.js';

// A friendly form for the documented kinds; the server's registry stays authoritative, and an
// unknown kind falls back to free-form key=value pairs (spec §2.5, §6.4).
export const KNOWN_KINDS: Record<string, string[]> = {
  bearer: ['token'],
  basic: ['username', 'password'],
  'api-key': ['key'],
  'oauth2-token': ['accessToken'],
};

const CONSUMERS: CredentialConsumer[] = ['inference', 'sandbox-egress', 'control-plane'];
export const CREDENTIAL_NAME = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

const LABELS: Record<string, string> = {
  token: 'Token',
  username: 'Username',
  password: 'Password',
  key: 'API key',
  accessToken: 'Access token',
};

export function credentialFields(): FormField[] {
  const secretFields = [...new Set(Object.values(KNOWN_KINDS).flat())];
  return [
    {
      key: 'name',
      label: 'Name',
      hint: 'lower-case letters, digits and dashes, e.g. anthropic-work',
    },
    { key: 'kind', label: 'Kind', initial: 'bearer', suggestions: Object.keys(KNOWN_KINDS) },
    { key: 'consumer', label: 'Consumer', initial: 'inference', suggestions: CONSUMERS },
    {
      key: 'hosts',
      label: 'Destination hosts',
      hint: 'comma-separated host allow-list, e.g. api.anthropic.com',
    },
    {
      key: 'endpoint',
      label: 'Gateway endpoint',
      optional: true,
      hint: 'full origin, e.g. https://litellm.internal/v1; empty uses the deployment default',
      visible: (v) => v.consumer === 'inference',
    },
    ...secretFields.map((key) => ({
      key,
      label: LABELS[key] ?? key,
      masked: true,
      visible: (v: Record<string, string>) => (KNOWN_KINDS[v.kind] ?? []).includes(key),
    })),
    {
      key: 'secretPairs',
      label: 'Secret fields',
      masked: true,
      hint: 'key=value, key=value — the fields this kind requires',
      visible: (v) => !(v.kind in KNOWN_KINDS),
    },
  ];
}

function parseHosts(text: string): string[] {
  return text
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
}

function parsePairs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

export function validateCredential(values: Record<string, string>): string | undefined {
  if (!CREDENTIAL_NAME.test(values.name ?? ''))
    return 'name: lower-case letters, digits and dashes, 1-40 characters';
  if (!CONSUMERS.includes(values.consumer as CredentialConsumer))
    return `consumer must be one of ${CONSUMERS.join(', ')}`;
  if (parseHosts(values.hosts ?? '').length === 0)
    return 'destination hosts: at least one host is required';
  const fields = KNOWN_KINDS[values.kind];
  if (values.consumer === 'inference') {
    if (fields) {
      if (fields.length !== 1) {
        return `an inference credential needs a single-secret kind; '${values.kind}' has ${fields.length} (${fields.join(', ')})`;
      }
    } else {
      const pairs = Object.keys(parsePairs(values.secretPairs ?? ''));
      if (pairs.length !== 1) {
        return `an inference credential needs a single-secret kind; '${values.kind}' has ${pairs.length} (${pairs.join(', ')})`;
      }
    }
  }
  return undefined;
}

export function toPutRequest(values: Record<string, string>): {
  name: string;
  req: PutCredentialRequest;
} {
  const known = KNOWN_KINDS[values.kind];
  const secret = known
    ? Object.fromEntries(known.map((k) => [k, values[k] ?? '']))
    : parsePairs(values.secretPairs ?? '');
  const hosts = parseHosts(values.hosts ?? '');
  const consumer = values.consumer as CredentialConsumer;
  const req: PutCredentialRequest = { kind: values.kind, consumer, destination: { hosts }, secret };
  if (consumer === 'inference' && values.endpoint?.trim()) req.endpoint = values.endpoint.trim();
  return { name: values.name, req };
}
