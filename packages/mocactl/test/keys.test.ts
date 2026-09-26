import { describe, expect, it } from 'vitest';
import { chordFor } from '../src/commands/keys.js';

describe('chordFor', () => {
  it('ctrl+x starts a leader and the next key completes the chord', () => {
    expect(chordFor('x', { ctrl: true }, false)).toEqual({ kind: 'leader' });
    expect(chordFor('n', {}, true)).toEqual({ kind: 'chord', chord: 'ctrl+x n' });
  });

  it('a ctrl letter after the leader keeps its modifier', () => {
    expect(chordFor('d', { ctrl: true }, true)).toEqual({ kind: 'chord', chord: 'ctrl+x ctrl+d' });
  });

  it('escape cancels a pending leader', () => {
    expect(chordFor('', { escape: true }, true)).toEqual({ kind: 'none' });
  });

  it('a standalone ctrl letter is its own chord; plain typing is not a chord', () => {
    expect(chordFor('p', { ctrl: true }, false)).toEqual({ kind: 'chord', chord: 'ctrl+p' });
    expect(chordFor('a', {}, false)).toEqual({ kind: 'none' });
  });
});
