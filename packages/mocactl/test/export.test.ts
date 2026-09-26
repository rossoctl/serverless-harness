import { describe, expect, it } from 'vitest';
import type { Block } from '../src/render/blocks.js';
import { transcriptToMarkdown } from '../src/render/export.js';

describe('transcriptToMarkdown', () => {
  it('writes prompts, replies, tool calls and usage as Markdown', () => {
    const blocks: Block[] = [
      { kind: 'user', id: 0, text: 'fix the bug' },
      { kind: 'assistant', id: 1, text: 'Looking.', thinking: 'hm', final: true },
      {
        kind: 'tool',
        id: 2,
        toolId: 't',
        name: 'bash',
        args: { command: 'pnpm test' },
        result: { isError: true, preview: '1 failed' },
      },
      {
        kind: 'turn-end',
        id: 3,
        outcome: 'done',
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
      },
      { kind: 'notice', id: 4, text: 'ignored', tone: 'info' },
    ];
    expect(transcriptToMarkdown('Payments', blocks)).toBe(
      [
        '# Payments',
        '',
        '## You',
        '',
        'fix the bug',
        '',
        '## Assistant',
        '',
        'Looking.',
        '',
        '- `$ pnpm test` — failed',
        '',
        '_10 in · 5 out_',
        '',
      ].join('\n'),
    );
  });
});
