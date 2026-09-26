import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { InputBox } from '../src/views/InputBox.js';
import { KEY, tick, withTheme } from './helpers/ink.js';

function setup(over: Partial<Parameters<typeof InputBox>[0]> = {}) {
  const onSubmit = vi.fn();
  const onHelp = vi.fn();
  const r = render(
    withTheme(
      <InputBox
        active
        history={['older', 'newest']}
        onSubmit={onSubmit}
        onHelp={onHelp}
        {...over}
      />,
    ),
  );
  return { ...r, onSubmit, onHelp };
}

describe('InputBox', () => {
  it('submits trimmed text on Enter and clears', async () => {
    const { stdin, lastFrame, onSubmit } = setup();
    stdin.write(' hi ');
    await tick();
    stdin.write(KEY.enter);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('hi');
    expect(lastFrame()).not.toContain('hi');
  });

  it('ignores Enter on an empty input', async () => {
    const { stdin, onSubmit } = setup();
    stdin.write(KEY.enter);
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('inserts a newline on alt+enter instead of submitting', async () => {
    const { stdin, lastFrame, onSubmit } = setup();
    stdin.write('a');
    await tick();
    stdin.write('\u001b\r');
    await tick();
    stdin.write('b');
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(lastFrame()).toMatch(/a[^\n]*\n[^\n]*b/);
  });

  it('inserts a pasted multi-line chunk verbatim', async () => {
    const { stdin, lastFrame, onSubmit } = setup();
    stdin.write('line1\nline2');
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('line1');
    expect(lastFrame()).toContain('line2');
  });

  it('deletes with backspace', async () => {
    const { stdin, lastFrame } = setup();
    stdin.write('abc');
    await tick();
    stdin.write(KEY.backspace);
    await tick();
    expect(lastFrame()).toContain('ab');
    expect(lastFrame()).not.toContain('abc');
  });

  it('walks history newest first with the arrow keys', async () => {
    const { stdin, lastFrame } = setup();
    stdin.write(KEY.up);
    await tick();
    expect(lastFrame()).toContain('newest');
    stdin.write(KEY.up);
    await tick();
    expect(lastFrame()).toContain('older');
    stdin.write(KEY.down);
    await tick();
    expect(lastFrame()).toContain('newest');
  });

  it('clamps the history index so extra downs on an empty input do not strand it', async () => {
    const { stdin, lastFrame } = setup();
    stdin.write(KEY.down);
    await tick();
    stdin.write(KEY.down);
    await tick();
    stdin.write(KEY.down);
    await tick();
    stdin.write(KEY.up);
    await tick();
    expect(lastFrame()).toContain('newest');
  });

  it('opens help on ? in an empty input, but types ? otherwise', async () => {
    const { stdin, lastFrame, onHelp } = setup();
    stdin.write('?');
    await tick();
    expect(onHelp).toHaveBeenCalledTimes(1);
    stdin.write('x');
    await tick();
    stdin.write('?');
    await tick();
    expect(onHelp).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toContain('x?');
  });

  it('ignores keys while inactive', async () => {
    const { stdin, onSubmit } = setup({ active: false });
    stdin.write('hi');
    await tick();
    stdin.write(KEY.enter);
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('leaves ctrl chords to the app', async () => {
    const { stdin, lastFrame } = setup();
    stdin.write(KEY.ctrl('p'));
    await tick();
    expect(lastFrame()).toContain('type a message');
  });

  it('applies a prefill', async () => {
    const { lastFrame, rerender } = setup();
    rerender(
      withTheme(
        <InputBox
          active
          history={[]}
          onSubmit={vi.fn()}
          onHelp={vi.fn()}
          prefill={{ text: '/rename ', nonce: 1 }}
        />,
      ),
    );
    await tick();
    expect(lastFrame()).toContain('/rename');
  });
});
