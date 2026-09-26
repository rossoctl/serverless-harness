import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/errors.js';
import { describeError } from '../src/core/messages.js';
import { HarnessUntrustedError } from '../src/core/session-manager.js';

describe('describeError', () => {
  it.each([
    [
      new ApiError('control-plane', 401, 'token_expired'),
      'your login has expired — run `mocactl login` (or restart mocactl) to log in again',
    ],
    [
      new ApiError('control-plane', 404, 'session_not_found'),
      'that session no longer exists, or is not yours',
    ],
    [
      new ApiError('harness', 0, 'network_error', 'ECONNREFUSED'),
      'cannot reach the harness: ECONNREFUSED',
    ],
    [
      new ApiError('harness', 503, 'saturated', undefined, 4),
      'the harness has no capacity — retry in 4s',
    ],
    [
      new ApiError('control-plane', 503, 'redis_unavailable'),
      'the control plane is unavailable — try again shortly',
    ],
    [new HarnessUntrustedError(), new HarnessUntrustedError().message],
    ['plain', 'plain'],
  ])('%#', (err, text) => {
    expect(describeError(err)).toBe(text);
  });
});
