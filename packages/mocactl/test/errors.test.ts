import { describe, expect, it } from 'vitest';
import { ApiError, classify, errorFromResponse, networkError } from '../src/api/errors.js';
import { json } from './helpers/fake-fetch.js';

describe('errorFromResponse', () => {
  it('reads the error code, message and Retry-After', async () => {
    const e = await errorFromResponse(
      'harness',
      json({ error: 'saturated', message: 'no capacity' }, 503, { 'retry-after': '4' }),
    );
    expect(e).toMatchObject({
      source: 'harness',
      status: 503,
      code: 'saturated',
      message: 'no capacity',
      retryAfterS: 4,
    });
  });

  it('falls back to http_<status> for a non-JSON body', async () => {
    const e = await errorFromResponse('control-plane', new Response('oops', { status: 502 }));
    expect(e.code).toBe('http_502');
    expect(e.retryAfterS).toBeUndefined();
  });
});

describe('classify', () => {
  const err = (
    source: 'control-plane' | 'harness',
    status: number,
    code: string,
    retryAfterS?: number,
  ) => new ApiError(source, status, code, undefined, retryAfterS);

  it.each([
    [err('control-plane', 401, 'token_expired'), { kind: 'login' }],
    [err('control-plane', 401, 'token_invalid'), { kind: 'login' }],
    [err('harness', 401, 'token_invalid'), { kind: 'harness-token-rejected' }],
    [err('harness', 401, 'token_required'), { kind: 'harness-token-rejected' }],
    [err('control-plane', 404, 'session_not_found'), { kind: 'session-gone' }],
    [err('harness', 503, 'saturated', 4), { kind: 'retry-after', seconds: 4 }],
    [
      err('control-plane', 503, 'redis_unavailable'),
      { kind: 'unavailable', source: 'control-plane' },
    ],
    [err('harness', 503, 'credential_unavailable'), { kind: 'unavailable', source: 'harness' }],
    [err('control-plane', 500, 'internal_error'), { kind: 'unavailable', source: 'control-plane' }],
  ])('%s -> %j', (e, action) => {
    expect(classify(e)).toEqual(action);
  });

  it('names the failing endpoint for a network error', () => {
    expect(classify(networkError('harness', new Error('ECONNREFUSED')))).toEqual({
      kind: 'connection',
      source: 'harness',
      message: 'ECONNREFUSED',
    });
  });

  it('shows endpoint_unresolved and unknown codes with their message', () => {
    expect(classify(new ApiError('harness', 400, 'endpoint_unresolved', 'no gateway'))).toEqual({
      kind: 'endpoint-unresolved',
      message: 'no gateway',
    });
    expect(classify(new ApiError('control-plane', 400, 'brand_new_code', 'hi'))).toEqual({
      kind: 'show',
      message: 'hi',
    });
  });
});
