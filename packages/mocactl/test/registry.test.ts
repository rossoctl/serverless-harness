import { describe, expect, it, vi } from 'vitest';
import {
  CommandRegistry,
  fuzzyScore,
  normalizeKeybind,
  type Command,
} from '../src/commands/registry.js';

type Ctx = { hasSession: boolean };
const cmd = (id: string, over: Partial<Command<Ctx>> = {}): Command<Ctx> => ({
  id,
  title: id,
  run: vi.fn(),
  ...over,
});

const commands = [
  cmd('session.new', { title: 'New session', slash: ['new'], keybind: 'ctrl+x n' }),
  cmd('session.list', { title: 'Sessions', slash: ['sessions', 'resume'], keybind: 'ctrl+x l' }),
  cmd('session.rename', {
    title: 'Rename session',
    slash: ['rename'],
    keybind: 'ctrl+x r',
    when: (c) => c.hasSession,
  }),
  cmd('palette', { title: 'Command palette', keybind: 'ctrl+p' }),
];

describe('CommandRegistry', () => {
  it('resolves slash commands and aliases, splitting off the argument', () => {
    const r = new CommandRegistry(commands);
    expect(r.bySlash('/resume')?.command.id).toBe('session.list');
    expect(r.bySlash('/rename  My new title ')).toMatchObject({
      command: { id: 'session.rename' },
      arg: 'My new title',
    });
    expect(r.bySlash('/nope')).toBeUndefined();
    expect(r.bySlash('not a command')).toBeUndefined();
  });

  it('resolves keybind chords', () => {
    expect(new CommandRegistry(commands).byKeybind('ctrl+x n')?.id).toBe('session.new');
  });

  it('applies user overrides over defaults and reports the conflict it creates', () => {
    const r = new CommandRegistry(commands, { 'session.rename': 'ctrl+x n' });
    expect(r.byKeybind('ctrl+x n')?.id).toBe('session.rename');
    expect(r.keybindOf('session.new')).toBeUndefined();
    expect(r.conflicts).toEqual([
      'ctrl+x n is bound to both session.rename and session.new; keeping session.rename',
    ]);
  });

  it('lets an override unbind a key with an empty string', () => {
    const r = new CommandRegistry(commands, { palette: '' });
    expect(r.byKeybind('ctrl+p')).toBeUndefined();
    expect(r.conflicts).toEqual([]);
  });

  it('reports an override for an unknown command', () => {
    expect(new CommandRegistry(commands, { 'no.such': 'ctrl+x z' }).conflicts).toEqual([
      'keybind override for unknown command "no.such"',
    ]);
  });

  it('hides commands whose when() is false from search and help', () => {
    const r = new CommandRegistry(commands);
    expect(r.available({ hasSession: false }).map((c) => c.id)).not.toContain('session.rename');
    expect(r.help({ hasSession: true })).toContainEqual({
      title: 'Rename session',
      slash: '/rename',
      keybind: 'ctrl+x r',
    });
  });

  it('searches titles and slash names fuzzily, best first', () => {
    const r = new CommandRegistry(commands);
    expect(r.search('sessions', { hasSession: true }).map((c) => c.id)).toEqual(['session.list']);
    expect(r.search('rena', { hasSession: true })[0].id).toBe('session.rename');
    expect(r.search('nw', { hasSession: true }).map((c) => c.id)).toEqual(['session.new']);
    expect(r.search('', { hasSession: false })).toHaveLength(3);
  });
});

describe('fuzzyScore', () => {
  it('matches subsequences case-insensitively and rejects non-matches', () => {
    expect(fuzzyScore('NS', 'new session')).not.toBeNull();
    expect(fuzzyScore('xyz', 'new session')).toBeNull();
  });

  it('prefers consecutive, word-start matches', () => {
    expect(fuzzyScore('sess', 'sessions')!).toBeGreaterThan(
      fuzzyScore('sess', 'show extra settings')!,
    );
  });
});

describe('normalizeKeybind', () => {
  it('lower-cases and collapses whitespace', () => {
    expect(normalizeKeybind('  Ctrl+X   N ')).toBe('ctrl+x n');
  });
});
