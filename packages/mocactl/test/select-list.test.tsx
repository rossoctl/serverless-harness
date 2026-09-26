import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { SelectList, type ListItem } from '../src/views/SelectList.js';
import { KEY, tick, withTheme } from './helpers/ink.js';

const items: ListItem<string>[] = [
  { key: 'a', label: 'Fix payment bug', detail: '3h ago', value: 'a' },
  { key: 'b', label: 'Refactor auth', detail: '1d ago', value: 'b' },
  { key: 'c', label: 'Write docs', value: 'c' },
];

function setup(props: Partial<Parameters<typeof SelectList<string>>[0]> = {}) {
  const onSelect = vi.fn();
  const onCancel = vi.fn();
  const r = render(
    withTheme(
      <SelectList
        items={items}
        onSelect={onSelect}
        onCancel={onCancel}
        filter="slash"
        {...props}
      />,
    ),
  );
  return { ...r, onSelect, onCancel };
}

describe('SelectList', () => {
  it('moves with the arrows and selects with Enter', async () => {
    const { stdin, onSelect } = setup();
    stdin.write(KEY.down);
    await tick();
    stdin.write(KEY.enter);
    await tick();
    expect(onSelect).toHaveBeenCalledWith('b');
  });

  it('starts on initialKey', async () => {
    const { stdin, onSelect } = setup({ initialKey: 'c' });
    stdin.write(KEY.enter);
    await tick();
    expect(onSelect).toHaveBeenCalledWith('c');
  });

  it('cancels with Esc', async () => {
    const { stdin, onCancel } = setup();
    stdin.write(KEY.escape);
    await tick(80);
    expect(onCancel).toHaveBeenCalled();
  });

  it('dispatches single-letter keys to handlers in slash mode', async () => {
    const del = vi.fn();
    const { stdin } = setup({ keys: { d: del } });
    stdin.write(KEY.down);
    await tick();
    stdin.write('d');
    await tick();
    expect(del).toHaveBeenCalledWith('b');
  });

  it('filters after / and leaves filter mode on the first Esc', async () => {
    const { stdin, lastFrame, onCancel } = setup();
    stdin.write('/');
    await tick();
    stdin.write('auth');
    await tick();
    expect(lastFrame()).toContain('Refactor auth');
    expect(lastFrame()).not.toContain('Write docs');
    stdin.write(KEY.escape);
    await tick(80);
    expect(onCancel).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('Write docs');
  });

  it('always filters in palette mode', async () => {
    const { stdin, onSelect } = setup({ filter: 'always' });
    stdin.write('docs');
    await tick();
    stdin.write(KEY.enter);
    await tick();
    expect(onSelect).toHaveBeenCalledWith('c');
  });

  it('shows emptyText and still runs key handlers with no items', async () => {
    const make = vi.fn();
    const { stdin, lastFrame } = setup({
      items: [],
      emptyText: 'no sessions yet',
      keys: { n: make },
    });
    expect(lastFrame()).toContain('no sessions yet');
    stdin.write('n');
    await tick();
    expect(make).toHaveBeenCalledWith(undefined);
  });

  it('windows long lists to maxRows around the cursor', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      key: String(i),
      label: `item ${i}`,
      value: String(i),
    }));
    const { stdin, lastFrame } = setup({ items: many, maxRows: 5 });
    for (let i = 0; i < 10; i++) stdin.write(KEY.down);
    await tick();
    expect(lastFrame()).toContain('item 10');
    expect(lastFrame()).not.toContain('item 0\n');
  });
});
