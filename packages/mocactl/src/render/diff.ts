export type DiffLine =
  { kind: 'add' | 'remove' | 'context'; text: string } | { kind: 'hunk'; text: string };

export interface EditDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
}

const MAX_CELLS = 250_000;
const CONTEXT = 2;

/** Line-level LCS diff. Edits are targeted replacements, so the quadratic table stays small. */
export function diffLines(a: string[], b: string[]): DiffLine[] {
  if (a.length * b.length > MAX_CELLS) {
    return [
      ...a.map((text) => ({ kind: 'remove' as const, text })),
      ...b.map((text) => ({ kind: 'add' as const, text })),
    ];
  }
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'context', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'remove', text: a[i++] });
    } else {
      out.push({ kind: 'add', text: b[j++] });
    }
  }
  while (i < n) out.push({ kind: 'remove', text: a[i++] });
  while (j < m) out.push({ kind: 'add', text: b[j++] });
  return out;
}

// Keep CONTEXT lines either side of a change; collapse longer unchanged runs to one '…' line.
function trimContext(lines: DiffLine[]): DiffLine[] {
  const changed = lines.map((l) => l.kind === 'add' || l.kind === 'remove');
  const keep = lines.map((_, i) => {
    for (let d = -CONTEXT; d <= CONTEXT; d++) if (changed[i + d]) return true;
    return false;
  });
  const out: DiffLine[] = [];
  for (const [i, l] of lines.entries()) {
    if (keep[i]) out.push(l);
    else if (out.at(-1)?.text !== '…') out.push({ kind: 'context', text: '…' });
  }
  return out;
}

function isEdit(e: unknown): e is { oldText: string; newText: string } {
  const r = e as { oldText?: unknown; newText?: unknown } | null;
  return typeof r?.oldText === 'string' && typeof r.newText === 'string';
}

export function buildEditDiff(args: unknown): EditDiff | undefined {
  const edits = (args as { edits?: unknown } | null)?.edits;
  if (!Array.isArray(edits) || edits.length === 0 || !edits.every(isEdit)) return undefined;
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  for (const [i, e] of edits.entries()) {
    const d = diffLines(e.oldText.split('\n'), e.newText.split('\n'));
    added += d.filter((l) => l.kind === 'add').length;
    removed += d.filter((l) => l.kind === 'remove').length;
    if (edits.length > 1)
      lines.push({ kind: 'hunk', text: `@@ edit ${i + 1} of ${edits.length} @@` });
    lines.push(...trimContext(d));
  }
  return { lines, added, removed };
}
