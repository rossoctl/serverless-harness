import { buildEditDiff } from './diff.js';

// Spec §5.5. Argument shapes are Pi's (pi-fork/packages/coding-agent/src/core/tools/); a change
// degrades that tool to the generic summary rather than breaking it.

export interface ToolRenderer {
  summary(args: Record<string, unknown>): string;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const firstLine = (s: string) => s.split('\n')[0];
const lineCount = (s: string) => (s === '' ? 0 : s.replace(/\n$/, '').split('\n').length);

export function truncate(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max - 1).join('') + '…';
}

export const TOOL_RENDERERS: Record<string, ToolRenderer> = {
  bash: { summary: (a) => `$ ${firstLine(str(a.command))}` },
  read: {
    summary: (a) => {
      const offset = num(a.offset);
      const limit = num(a.limit);
      const range =
        offset !== undefined
          ? `:${offset}${limit !== undefined ? `-${offset + limit - 1}` : ''}`
          : '';
      return `read ${str(a.path)}${range}`;
    },
  },
  edit: {
    summary: (a) => {
      const d = buildEditDiff(a);
      return `edit ${str(a.path)}${d ? ` · +${d.added} −${d.removed}` : ''}`;
    },
  },
  write: { summary: (a) => `write ${str(a.path)} · ${lineCount(str(a.content))} lines` },
  grep: { summary: (a) => `grep ${str(a.pattern)}${a.path ? ` in ${str(a.path)}` : ''}` },
  find: { summary: (a) => `find ${str(a.pattern)}${a.path ? ` in ${str(a.path)}` : ''}` },
  ls: { summary: (a) => `ls ${str(a.path) || '.'}` },
};

export function toolSummary(name: string, args: unknown): string {
  const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const renderer = TOOL_RENDERERS[name];
  if (renderer) return renderer.summary(record);
  try {
    return truncate(`${name}(${JSON.stringify(args ?? {})})`, 80);
  } catch {
    return truncate(`${name}(…)`, 80);
  }
}
