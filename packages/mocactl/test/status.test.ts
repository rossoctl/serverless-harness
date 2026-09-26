import { describe, expect, it } from 'vitest';
import { describeTurn, fitStatus, type StatusField } from '../src/views/status.js';

describe('describeTurn', () => {
  const now = 100_000;
  it.each([
    [{ phase: 'idle', queued: 0 }, 'idle'],
    [{ phase: 'idle', queued: 0, lastTtftMs: 1400 }, 'idle · first token 1.4s'],
    [{ phase: 'waiting', startedAt: now - 3200, queued: 0 }, 'waiting for harness… 3.2s'],
    [{ phase: 'streaming', startedAt: now - 12_000, queued: 2 }, 'streaming 12.0s · queued: 2'],
    [{ phase: 'retrying', retryUntil: now + 3400, queued: 0 }, 'no capacity — retrying in 4s'],
  ] as const)('%j', (state, text) => {
    expect(describeTurn(state, now)).toBe(text);
  });
});

describe('fitStatus', () => {
  const fields: StatusField[] = [
    { key: 'subject', text: 'github:1' },
    { key: 'title', text: 'Fix the payment bug' },
    { key: 'turn', text: 'streaming 3.0s' },
    { key: 'usage', text: '1.2k in · 300 out' },
    { key: 'warning', text: 'login expires in 4m' },
  ];

  it('keeps everything when it fits', () => {
    expect(fitStatus(fields, 200)).toEqual(fields);
  });

  it('drops fields right to left but never the turn state', () => {
    expect(fitStatus(fields, 60).map((f) => f.key)).toEqual(['subject', 'title', 'turn']);
  });

  it('keeps only the turn state below 60 columns, truncated to fit', () => {
    expect(fitStatus(fields, 59).map((f) => f.key)).toEqual(['turn']);
    expect(fitStatus(fields, 8)[0].text).toBe('streami…');
  });
});
