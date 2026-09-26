import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_COMMANDS, type CommandHost } from '../src/commands/builtin.js';
import { CommandRegistry } from '../src/commands/registry.js';

function host(hasSession = true): CommandHost & Record<string, ReturnType<typeof vi.fn>> {
  const h = {
    hasSession: vi.fn(() => hasSession),
    openOverlay: vi.fn(),
    newSession: vi.fn(),
    renameSession: vi.fn(),
    prefillInput: vi.fn(),
    toggleDetails: vi.fn(),
    toggleThinking: vi.fn(),
    copyLastReply: vi.fn(),
    exportTranscript: vi.fn(),
    composeInEditor: vi.fn(),
    cycleTheme: vi.fn(),
    notify: vi.fn(),
    quit: vi.fn(),
  };
  return h as never;
}

const registry = new CommandRegistry(BUILTIN_COMMANDS);

describe('BUILTIN_COMMANDS', () => {
  it('has no keybind conflicts', () => {
    expect(registry.conflicts).toEqual([]);
  });

  // The command table of spec §5.2.
  it.each([
    ['/sessions', 'ctrl+x l'],
    ['/resume', 'ctrl+x l'],
    ['/new', 'ctrl+x n'],
    ['/rename', 'ctrl+x r'],
    ['/credentials', 'ctrl+x k'],
    ['/details', 'ctrl+x d'],
    ['/thinking', 'ctrl+x t'],
    ['/copy', 'ctrl+x y'],
    ['/export', 'ctrl+x x'],
    ['/editor', 'ctrl+x e'],
    ['/theme', undefined],
    ['/doctor', undefined],
    ['/help', undefined],
    ['/quit', 'ctrl+x q'],
  ])('%s is bound to %s', (slash, keybind) => {
    const hit = registry.bySlash(slash);
    expect(hit, slash).toBeDefined();
    expect(registry.keybindOf(hit!.command.id)).toBe(keybind);
  });

  it('opens the palette on ctrl+p', () => {
    const h = host();
    registry.byKeybind('ctrl+p')!.run(h, '');
    expect(h.openOverlay).toHaveBeenCalledWith('palette');
  });

  it.each([
    ['/sessions', 'openOverlay', 'sessions'],
    ['/credentials', 'openOverlay', 'credentials'],
    ['/doctor', 'openOverlay', 'doctor'],
    ['/help', 'openOverlay', 'help'],
    ['/new', 'newSession', undefined],
    ['/details', 'toggleDetails', undefined],
    ['/thinking', 'toggleThinking', undefined],
    ['/copy', 'copyLastReply', undefined],
    ['/export', 'exportTranscript', undefined],
    ['/editor', 'composeInEditor', undefined],
    ['/theme', 'cycleTheme', undefined],
    ['/quit', 'quit', undefined],
  ])('%s calls host.%s', async (slash, method, arg) => {
    const h = host();
    const { command, arg: a } = registry.bySlash(slash)!;
    await command.run(h, a);
    if (arg === undefined) expect(h[method]).toHaveBeenCalled();
    else expect(h[method]).toHaveBeenCalledWith(arg);
  });

  it('/rename with a title renames; without one it prefills the input', () => {
    const h = host();
    const hit = registry.bySlash('/rename Payment bug')!;
    hit.command.run(h, hit.arg);
    expect(h.renameSession).toHaveBeenCalledWith('Payment bug');
    registry.byKeybind('ctrl+x r')!.run(h, '');
    expect(h.prefillInput).toHaveBeenCalledWith('/rename ');
  });

  it('hides session-only commands when there is no session', () => {
    const ids = registry.available(host(false)).map((c) => c.id);
    expect(ids).not.toContain('session.rename');
    expect(ids).not.toContain('reply.copy');
    expect(ids).not.toContain('transcript.export');
    expect(ids).toContain('session.new');
  });
});
