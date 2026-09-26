import { describe, expect, it } from 'vitest';
import {
  credentialFields,
  toPutRequest,
  validateCredential,
} from '../src/views/overlays/credential-form.js';

const base = {
  name: 'anthropic',
  kind: 'bearer',
  consumer: 'inference',
  hosts: 'api.anthropic.com',
  endpoint: '',
};

describe('credentialFields', () => {
  it('shows only the secret fields of the chosen kind', () => {
    const visible = (values: Record<string, string>) =>
      credentialFields()
        .filter((f) => !f.visible || f.visible(values))
        .map((f) => f.key);
    expect(visible(base)).toEqual(['name', 'kind', 'consumer', 'hosts', 'endpoint', 'token']);
    expect(visible({ ...base, kind: 'basic', consumer: 'sandbox-egress' })).toEqual([
      'name',
      'kind',
      'consumer',
      'hosts',
      'username',
      'password',
    ]);
    expect(visible({ ...base, kind: 'sigv4' })).toContain('secretPairs');
  });

  it('masks every secret field', () => {
    const secretFields = credentialFields().filter((f) =>
      ['token', 'password', 'key', 'accessToken', 'secretPairs'].includes(f.key),
    );
    // Guards against the loop below passing vacuously if a rename or a filter typo drops a field.
    expect(secretFields).toHaveLength(5);
    for (const f of secretFields) {
      expect(f.masked, f.key).toBe(true);
    }
  });
});

describe('validateCredential', () => {
  it('accepts a valid inference credential', () => {
    expect(validateCredential({ ...base, token: 'x' })).toBeUndefined();
  });

  it.each([
    [{ ...base, name: 'Bad_Name' }, /lower-case letters, digits and dashes/],
    [{ ...base, consumer: 'nope' }, /consumer must be one of/],
    [{ ...base, hosts: '' }, /destination hosts: at least one host is required/],
    [{ ...base, hosts: ' , ,' }, /destination hosts: at least one host is required/],
    [{ ...base, kind: 'basic' }, /inference credential needs a single-secret kind/],
  ])('rejects %j', (values, message) => {
    expect(validateCredential(values)).toMatch(message);
  });

  it('refuses an unknown kind for an inference consumer unless it has exactly one secret field', () => {
    expect(
      validateCredential({ ...base, kind: 'sigv4', secretPairs: 'accessKey=a,secretKey=b' }),
    ).toMatch(/inference credential needs a single-secret kind.*'sigv4' has 2/);
    expect(
      validateCredential({ ...base, kind: 'sigv4', secretPairs: 'accessKey=a' }),
    ).toBeUndefined();
  });
});

describe('toPutRequest', () => {
  it('builds the request for a known kind', () => {
    expect(
      toPutRequest({
        ...base,
        hosts: 'api.anthropic.com, gw.example',
        endpoint: 'https://gw.example/v1',
        token: 'sk-x',
      }),
    ).toEqual({
      // notsecret
      name: 'anthropic',
      req: {
        kind: 'bearer',
        consumer: 'inference',
        destination: { hosts: ['api.anthropic.com', 'gw.example'] },
        endpoint: 'https://gw.example/v1',
        secret: { token: 'sk-x' }, // notsecret
      },
    });
  });

  it('parses key=value pairs for an unknown kind and drops the endpoint for other consumers', () => {
    expect(
      toPutRequest({
        ...base,
        hosts: '',
        kind: 'sigv4',
        consumer: 'sandbox-egress',
        endpoint: 'ignored',
        secretPairs: 'accessKey=a, secretKey=b=c',
      }).req,
    ).toEqual({
      kind: 'sigv4',
      consumer: 'sandbox-egress',
      destination: { hosts: [] },
      secret: { accessKey: 'a', secretKey: 'b=c' },
    });
  });
});
