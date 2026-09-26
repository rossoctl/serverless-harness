import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/errors.js';
import { describeError } from '../src/core/messages.js';
import { sanitizeRemote } from '../src/core/sanitize.js';

describe('sanitizeRemote', () => {
  it('strips OSC, SGR and CSI sequences but keeps newlines and tabs', () => {
    expect(sanitizeRemote('a\u001b]52;c;eA==\u0007b\u001b[8mc\u001b[0m\td\ne\u001b[2J')).toBe(
      'abc\td\ne',
    );
  });

  it('removes stray C0/C1 controls, so a sequence split across two deltas stays inert', () => {
    // The first half of an OSC 52 in one delta, the rest in the next.
    expect(sanitizeRemote('x\u001b]52;c;') + sanitizeRemote('eA==\u0007y')).not.toMatch(
      /[\u0007\u001b]/,
    );
    expect(sanitizeRemote('a\u009b31mb\u009d0;t\u0007\u0000\u007f')).not.toMatch(
      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/,
    );
  });

  it('is applied to every error message describeError produces', () => {
    const err = new ApiError('control-plane', 400, 'bad_request', 'no\u001b]0;title\u0007pe');
    expect(describeError(err)).toBe('nope');
    expect(describeError(new Error('x\u001b[8my'))).toBe('xy');
  });
});
