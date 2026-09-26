import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { DARK_TOKENS, SYSTEM_TOKENS, resolveTheme, toChalk } from '../src/theme/tokens.js';
import { Spinner } from '../src/views/Spinner.js';
import { tick, withTheme } from './helpers/ink.js';

describe('resolveTheme', () => {
  it('maps the system theme onto ANSI colour names and leaves text to the terminal', () => {
    const t = resolveTheme('system', {}, false);
    expect(t.tokens).toBe(SYSTEM_TOKENS);
    expect(t.tokens.error).toBe('red');
    expect(t.tokens.text).toBeUndefined();
  });

  it('uses truecolor values for the dark theme', () => {
    expect(resolveTheme('dark', {}, false).tokens.primary).toMatch(/^#[0-9a-f]{6}$/i);
    expect(DARK_TOKENS.diffAdd).toBeDefined();
  });

  it('empties every token under NO_COLOR, but ignores an empty NO_COLOR', () => {
    expect(resolveTheme('dark', { NO_COLOR: '1' }, false)).toMatchObject({
      tokens: {},
      noColor: true,
    });
    expect(resolveTheme('dark', { NO_COLOR: '' }, false).noColor).toBe(false);
  });
});

describe('toChalk', () => {
  it('is the identity for no colour and for an unknown name', () => {
    expect(toChalk(undefined)('x')).toBe('x');
    expect(toChalk('not-a-colour')('x')).toBe('x');
  });

  it('returns a function for ANSI names and hex values', () => {
    expect(typeof toChalk('red')).toBe('function');
    expect(toChalk('#ff0000')('x')).toContain('x');
  });
});

describe('Spinner', () => {
  it('renders a static ellipsis with reduced motion', async () => {
    const { lastFrame } = render(withTheme(<Spinner label="waiting" />));
    const first = lastFrame();
    await tick(200);
    expect(lastFrame()).toBe(first);
    expect(first).toBe('… waiting');
  });

  it('animates otherwise', async () => {
    const { lastFrame, unmount } = render(
      withTheme(<Spinner />, resolveTheme('system', {}, false)),
    );
    const first = lastFrame();
    await tick(200);
    expect(lastFrame()).not.toBe(first);
    unmount();
  });
});
