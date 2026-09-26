export interface KeyInfo {
  ctrl?: boolean;
  meta?: boolean;
  escape?: boolean;
  return?: boolean;
}

export type ChordResult = { kind: 'leader' } | { kind: 'chord'; chord: string } | { kind: 'none' };

// OpenCode's leader key: ctrl+x, then a mnemonic letter (spec §5.2).
export function chordFor(input: string, key: KeyInfo, leaderPending: boolean): ChordResult {
  if (leaderPending) {
    if (key.escape || !input) return { kind: 'none' };
    return {
      kind: 'chord',
      chord: `ctrl+x ${key.ctrl ? `ctrl+${input.toLowerCase()}` : input.toLowerCase()}`,
    };
  }
  if (key.ctrl && input.toLowerCase() === 'x') return { kind: 'leader' };
  if (key.ctrl && /^[a-z]$/i.test(input))
    return { kind: 'chord', chord: `ctrl+${input.toLowerCase()}` };
  return { kind: 'none' };
}
