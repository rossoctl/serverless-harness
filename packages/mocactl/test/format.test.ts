import { describe, expect, it } from 'vitest';
import { formatDuration, formatRelative, formatTokens, formatUsage } from '../src/views/format.js';

describe('format', () => {
  it.each([
    [999, '999'],
    [1234, '1.2k'],
    [12_345, '12k'],
    [1_234_567, '1.2M'],
  ])('formatTokens(%d) = %s', (n, s) => expect(formatTokens(n)).toBe(s));

  it('formats usage, adding cache reads only when present', () => {
    expect(formatUsage({ input: 120, output: 40, cacheRead: 0 })).toBe('120 in · 40 out');
    expect(formatUsage({ input: 120, output: 40, cacheRead: 2000 })).toBe(
      '120 in · 40 out · 2.0k cached',
    );
  });

  it('formats durations', () => {
    expect(formatDuration(3240)).toBe('3.2s');
    expect(formatDuration(64_000)).toBe('1m04s');
  });

  it('formats relative times', () => {
    const now = 10 * 86_400_000;
    expect(formatRelative(now - 10_000, now)).toBe('just now');
    expect(formatRelative(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(formatRelative(now - 2 * 86_400_000, now)).toBe('2d ago');
  });
});
