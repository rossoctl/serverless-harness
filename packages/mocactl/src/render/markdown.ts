import chalk from 'chalk';
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { stripVTControlCharacters } from 'node:util';
import { sanitizeRemote } from '../core/sanitize.js';
import { toChalk, type Theme } from '../theme/tokens.js';

// Spec §5.6: a finished reply is rendered once as Markdown; the streaming one stays plain text.

const cache = new Map<string, Marked>();

function instance(theme: Theme, width: number): Marked {
  const key = `${theme.name}:${theme.noColor}:${width}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const t = theme.tokens;
  const c = toChalk;
  const heading = (s: string) => chalk.bold(c(t.primary)(s));
  const marked = new Marked(
    markedTerminal(
      {
        width,
        reflowText: true,
        showSectionPrefix: false,
        tab: 2,
        heading,
        firstHeading: heading,
        strong: (s: string) => chalk.bold(s),
        em: (s: string) => chalk.italic(s),
        codespan: c(t.code),
        code: c(t.code),
        link: c(t.info),
        href: c(t.info),
        blockquote: (s: string) => c(t.muted)(chalk.italic(s)),
        hr: c(t.border),
      },
      {
        theme: {
          keyword: c(t.accent),
          built_in: c(t.info),
          type: c(t.info),
          string: c(t.success),
          number: c(t.warning),
          literal: c(t.warning),
          comment: c(t.muted),
          function: c(t.primary),
          title: c(t.primary),
        },
      },
    ),
  );
  cache.set(key, marked);
  return marked;
}

export function renderMarkdown(text: string, theme: Theme, width: number): string {
  // The input is the model's reply: its own escape sequences are stripped before the theme's.
  const out = (instance(theme, Math.max(20, width)).parse(sanitizeRemote(text)) as string).replace(
    /\n+$/,
    '',
  );
  return theme.noColor ? stripVTControlCharacters(out) : out;
}
