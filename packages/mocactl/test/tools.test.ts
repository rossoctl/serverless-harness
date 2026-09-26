import { describe, expect, it } from 'vitest';
import { toolSummary } from '../src/render/tools.js';

describe('toolSummary', () => {
  it.each([
    ['bash', { command: 'pnpm test\n--run' }, '$ pnpm test'],
    ['read', { path: 'src/a.ts' }, 'read src/a.ts'],
    ['read', { path: 'src/a.ts', offset: 10, limit: 20 }, 'read src/a.ts:10-29'],
    ['edit', { path: 'a.ts', edits: [{ oldText: 'a', newText: 'b\nc' }] }, 'edit a.ts · +2 −1'],
    ['write', { path: 'n.md', content: 'x\ny\n' }, 'write n.md · 2 lines'],
    ['grep', { pattern: 'TODO', path: 'src' }, 'grep TODO in src'],
    ['find', { pattern: '*.ts' }, 'find *.ts'],
    ['ls', {}, 'ls .'],
  ])('%s %j -> %s', (name, args, expected) => {
    expect(toolSummary(name, args)).toBe(expected);
  });

  it('falls back to name(args) truncated to 80 characters for unknown tools', () => {
    expect(toolSummary('mcp_call', { a: 1 })).toBe('mcp_call({"a":1})');
    const long = toolSummary('mcp_call', { a: 'x'.repeat(200) });
    expect(Array.from(long).length).toBe(80);
    expect(long.endsWith('…')).toBe(true);
  });

  it('tolerates non-object arguments', () => {
    expect(toolSummary('bash', 'oops')).toBe('$ ');
  });

  it('handles circular objects without throwing', () => {
    const circ: any = { a: 1 };
    circ.self = circ;
    expect(() => toolSummary('custom', circ)).not.toThrow();
    const result = toolSummary('custom', circ);
    expect(result).toBe('custom(…)');
  });
});
