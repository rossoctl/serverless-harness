import { describe, expect, it } from 'vitest';
import { buildEditDiff, diffLines } from '../src/render/diff.js';

describe('diffLines', () => {
  it('keeps common lines as context and marks changes', () => {
    expect(diffLines(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'remove', text: 'b' },
      { kind: 'add', text: 'x' },
      { kind: 'context', text: 'c' },
    ]);
  });

  it('handles pure additions and removals', () => {
    expect(diffLines([], ['a'])).toEqual([{ kind: 'add', text: 'a' }]);
    expect(diffLines(['a'], [])).toEqual([{ kind: 'remove', text: 'a' }]);
  });

  it('falls back to remove-then-add for very large inputs', () => {
    const a = Array.from({ length: 600 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 600 }, (_, i) => `b${i}`);
    const out = diffLines(a, b);
    expect(out).toHaveLength(1200);
    expect(out[0].kind).toBe('remove');
    expect(out[600].kind).toBe('add');
  });
});

describe('buildEditDiff', () => {
  it('diffs each edit and counts added and removed lines', () => {
    const d = buildEditDiff({
      path: 'a.ts',
      edits: [
        { oldText: 'let x = 1;', newText: 'const x = 1;' },
        { oldText: 'a\nb', newText: 'a\nb\nc' },
      ],
    })!;
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
    expect(d.lines.filter((l) => l.kind === 'hunk')).toHaveLength(2);
  });

  it('collapses long runs of unchanged context', () => {
    const same = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    const d = buildEditDiff({
      path: 'a',
      edits: [{ oldText: `${same}\nold`, newText: `${same}\nnew` }],
    })!;
    expect(d.lines.some((l) => l.kind === 'context' && l.text === '…')).toBe(true);
    expect(d.lines.filter((l) => l.kind === 'context').length).toBeLessThan(10);
  });

  it('returns undefined for arguments that are not edits', () => {
    expect(buildEditDiff({ path: 'a' })).toBeUndefined();
    expect(buildEditDiff({ edits: [{ oldText: 1 }] })).toBeUndefined();
    expect(buildEditDiff(null)).toBeUndefined();
  });
});
