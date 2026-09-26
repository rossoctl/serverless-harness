import chalk from 'chalk';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/render/markdown.js';
import { resolveTheme } from '../src/theme/tokens.js';

const system = resolveTheme('system', {}, true);
const plain = (s: string) => stripVTControlCharacters(s);
const level = chalk.level;
afterEach(() => void (chalk.level = level));

describe('renderMarkdown', () => {
  it('renders headings, emphasis, inline code and lists without markdown syntax', () => {
    const out = plain(
      renderMarkdown('# Title\n\nSome **bold** and `code`.\n\n- one\n- two', system, 80),
    );
    for (const word of ['Title', 'bold', 'code', 'one', 'two']) expect(out).toContain(word);
    expect(out).not.toContain('**');
    expect(out).not.toMatch(/^# /m);
    expect(out.endsWith('\n')).toBe(false);
  });

  it('keeps fenced code content intact', () => {
    expect(plain(renderMarkdown('```js\nconst x = 1;\n```', system, 80))).toContain('const x = 1;');
  });

  it('wraps paragraphs to the given width', () => {
    const text = 'word '.repeat(60).trim();
    for (const line of plain(renderMarkdown(text, system, 40)).split('\n')) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
  });

  it('styles output when colour is available', () => {
    chalk.level = 1;
    expect(renderMarkdown('# Title', system, 80)).toContain('\u001b[');
  });

  it('emits no escape codes under NO_COLOR', () => {
    chalk.level = 1;
    const out = renderMarkdown(
      '# Title\n\n**b** `c`',
      resolveTheme('system', { NO_COLOR: '1' }, true),
      80,
    );
    expect(out).not.toContain('\u001b');
  });
});
