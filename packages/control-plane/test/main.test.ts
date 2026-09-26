import { generateKeyPairSync } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { configFromEnv, portFromEnv, verifyKeysFromEnv } from '../src/main.js';
import { keyIdFor, publicKeyToBase64 } from '../src/token.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PRIVATE_PEM = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const KEK = randomBytes(32).toString('base64'); // notsecret

const baseEnv = {
  SH_SESSION_TOKEN_PRIVATE_KEY: PRIVATE_PEM,
  SH_CREDENTIAL_KEK: KEK,
  SH_GITHUB_CLIENT_ID: 'Iv1.fake', // notsecret
  SH_EXCHANGE_TOKEN: 'shared-abc', // notsecret
} as NodeJS.ProcessEnv;

describe('portFromEnv', () => {
  it('defaults to 8080 and rejects nonsense rather than binding port NaN', () => {
    expect(portFromEnv({})).toBe(8080);
    expect(portFromEnv({ SH_CONTROL_PLANE_PORT: '9090' })).toBe(9090);
    expect(portFromEnv({ SH_CONTROL_PLANE_PORT: 'abc' })).toBe(8080);
    expect(portFromEnv({ SH_CONTROL_PLANE_PORT: '-1' })).toBe(8080);
  });
});

describe('configFromEnv', () => {
  it('uses the spec`s defaults', () => {
    const c = configFromEnv(baseEnv);
    expect(c.apiTokenTtlSeconds).toBe(3600);
    expect(c.sessionTokenTtlSeconds).toBe(300); // a session outlives a 5-minute token (spec §4.2)
    expect(c.allowOperatorFallback).toBe(false); // spec §6.4: default false
    expect(c.injectorConfigured).toBe(false);
    expect(c.sandboxNamespace).toBe('default');
  });

  it('reads the operator fallback only from an explicit true', () => {
    expect(
      configFromEnv({ ...baseEnv, SH_ALLOW_OPERATOR_FALLBACK: 'true' }).allowOperatorFallback,
    ).toBe(true);
    for (const v of ['1', 'yes', 'TRUE', '', 'false']) {
      // Exactly 'true', because a typo must not silently switch on a fallback that lets one subject
      // spend the operator's key.
      expect(
        configFromEnv({ ...baseEnv, SH_ALLOW_OPERATOR_FALLBACK: v }).allowOperatorFallback,
        v,
      ).toBe(v === 'true');
    }
  });

  it('carries the exchange token and the endpoints through', () => {
    const c = configFromEnv({
      ...baseEnv,
      SH_DEFAULT_INFERENCE_ENDPOINT: 'https://litellm/v1',
      SH_OPERATOR_INFERENCE_TOKEN: 'sk-op', // notsecret
      SH_INJECTOR_CONFIGURED: 'true',
      SH_SANDBOX_NAMESPACE: 'sandboxes',
    });
    expect(c).toMatchObject({
      exchangeToken: 'shared-abc', // notsecret
      defaultInferenceEndpoint: 'https://litellm/v1',
      operatorInferenceToken: 'sk-op', // notsecret
      injectorConfigured: true,
      sandboxNamespace: 'sandboxes',
    });
  });

  it('advertises SH_PUBLIC_HARNESS_URL without trailing slashes, and nothing when unset', () => {
    expect(configFromEnv(baseEnv).publicHarnessUrl).toBeUndefined();
    expect(
      configFromEnv({ ...baseEnv, SH_PUBLIC_HARNESS_URL: 'https://harness.example.com/' })
        .publicHarnessUrl,
    ).toBe('https://harness.example.com');
  });

  it('refuses to start with a SH_PUBLIC_HARNESS_URL no client could use', () => {
    for (const bad of ['harness.example.com', 'ftp://harness', 'not a url']) {
      expect(() => configFromEnv({ ...baseEnv, SH_PUBLIC_HARNESS_URL: bad }), bad).toThrow(
        /SH_PUBLIC_HARNESS_URL must be an absolute http\(s\) URL/,
      );
    }
  });
});

describe('verifyKeysFromEnv', () => {
  it('always includes the signer`s own public key', () => {
    const keys = verifyKeysFromEnv(baseEnv, publicKeyToBase64(publicKey));
    expect(keys.has(keyIdFor(publicKey))).toBe(true);
  });

  it('adds any extra published keys, so a rotation window verifies both', () => {
    const other = generateKeyPairSync('ed25519').publicKey;
    const keys = verifyKeysFromEnv(
      {
        ...baseEnv,
        SH_SESSION_TOKEN_PUBLIC_KEYS: `${keyIdFor(other)}:${publicKeyToBase64(other)}`,
      },
      publicKeyToBase64(publicKey),
    );
    expect(keys.size).toBe(2);
  });
});

describe('fail-fast on missing configuration', () => {
  it('refuses to start with no signing key, KEK, client id or exchange token', () => {
    for (const missing of [
      'SH_SESSION_TOKEN_PRIVATE_KEY',
      'SH_CREDENTIAL_KEK',
      'SH_GITHUB_CLIENT_ID',
      'SH_EXCHANGE_TOKEN',
    ]) {
      const env = { ...baseEnv };
      delete env[missing];
      // Fail at STARTUP, not on the first request: a control plane that boots without a KEK would
      // accept credential writes it cannot encrypt, and one without an exchange token would 401
      // every turn with a healthy-looking pod.
      expect(() => configFromEnv(env), missing).toThrow(new RegExp(missing));
    }
  });
});
