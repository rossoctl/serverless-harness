import { createClient } from 'redis';
import { fileURLToPath } from 'node:url';
import type { KeyObject } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { keksFromBase64 } from './envelope.js';
import { adminSubjectsFromEnv, GithubOAuthProvider } from './identity.js';
import { K8sSecretStore } from './k8s-secret-store.js';
import { defaultRunKubectl } from './kubectl.js';
import { OwnershipIndex, type CpRedisLike } from './ownership.js';
import { startControlPlane } from './server.js';
import type { CpConfig, CpDeps } from './handlers.js';
import { keyIdFor, makeSigner, parseKeyset, publicKeyFromBase64 } from './token.js';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) {
    // Fail at STARTUP. A control plane that booted without a KEK would accept credential writes it
    // cannot encrypt; one without an exchange token would 401 every turn from a healthy-looking pod.
    throw new Error(`${name} is required`);
  }
  return v;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, def: number): number {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

/**
 * An optional absolute http(s) URL, trailing slashes dropped. A malformed value fails STARTUP: a
 * control plane advertising a harness URL no client can use would fail every user's first turn.
 */
function urlEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name];
  if (!v) return undefined;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL, got "${v}"`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    throw new Error(`${name} must be an absolute http(s) URL, got "${v}"`);
  return v.replace(/\/+$/, '');
}

export function portFromEnv(env: NodeJS.ProcessEnv): number {
  return intEnv(env, 'SH_CONTROL_PLANE_PORT', 8080);
}

export function configFromEnv(env: NodeJS.ProcessEnv): CpConfig {
  required(env, 'SH_SESSION_TOKEN_PRIVATE_KEY');
  required(env, 'SH_GITHUB_CLIENT_ID');
  keksFromBase64(required(env, 'SH_CREDENTIAL_KEK'));
  return {
    apiTokenTtlSeconds: intEnv(env, 'SH_API_TOKEN_TTL_SECONDS', 3600),
    // A session outlives a 5-minute token; POST /v1/sessions/{id}/token re-mints (spec §4.2).
    sessionTokenTtlSeconds: intEnv(env, 'SH_SESSION_TOKEN_TTL_SECONDS', 300),
    exchangeToken: required(env, 'SH_EXCHANGE_TOKEN'),
    defaultInferenceEndpoint: env.SH_DEFAULT_INFERENCE_ENDPOINT || undefined,
    operatorInferenceToken: env.SH_OPERATOR_INFERENCE_TOKEN || undefined,
    // Exactly 'true'. A typo must not silently switch on a fallback that lets one subject spend the
    // operator's key (spec §6.4 defaults it off).
    allowOperatorFallback: env.SH_ALLOW_OPERATOR_FALLBACK === 'true',
    injectorConfigured: env.SH_INJECTOR_CONFIGURED === 'true',
    sandboxNamespace: env.SH_SANDBOX_NAMESPACE || 'default',
    publicHarnessUrl: urlEnv(env, 'SH_PUBLIC_HARNESS_URL'),
  };
}

/** The signer's own public key, plus any extra published ones so a rotation window verifies both. */
export function verifyKeysFromEnv(
  env: NodeJS.ProcessEnv,
  signerPublicKeyBase64: string,
): Map<string, KeyObject> {
  const keys = parseKeyset(env.SH_SESSION_TOKEN_PUBLIC_KEYS);
  const own = publicKeyFromBase64(signerPublicKeyBase64);
  keys.set(keyIdFor(own), own);
  return keys;
}

export function depsFromEnv(env: NodeJS.ProcessEnv): CpDeps {
  const config = configFromEnv(env);
  const signer = makeSigner(env.SH_SESSION_TOKEN_PRIVATE_KEY!);
  const client = createClient({ url: env.REDIS_URL ?? 'redis://127.0.0.1:6379' });
  // Connect eagerly and log; readyz reports the failure, so a Redis outage is visible rather than
  // turning every session route into an opaque 500.
  void client.connect().catch((err) => console.error('[control-plane] redis connect failed', err));
  return {
    index: new OwnershipIndex(client as unknown as CpRedisLike),
    credentials: new K8sSecretStore({
      namespace: env.SH_CREDENTIAL_NAMESPACE ?? 'sh-credentials',
      keks: keksFromBase64(env.SH_CREDENTIAL_KEK),
      run: defaultRunKubectl,
    }),
    identity: new GithubOAuthProvider({
      clientId: env.SH_GITHUB_CLIENT_ID!,
      adminSubjects: adminSubjectsFromEnv(env.SH_ADMIN_SUBJECTS),
    }),
    signer,
    verifyKeys: verifyKeysFromEnv(env, signer.publicKeyBase64),
    config,
    now: () => Date.now(),
    // randomUUID, so a control-plane-minted id is always identical to its leafSessionId
    // sanitisation and the cascade needs no sanitising helper (plan gap #10).
    newId: () => randomUUID(),
    runKubectl: defaultRunKubectl,
  };
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  startControlPlane(depsFromEnv(process.env), portFromEnv(process.env));
}
