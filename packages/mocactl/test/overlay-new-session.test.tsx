import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { CredentialDescriptor } from '../src/api/types.js';
import { NewSessionOverlay } from '../src/views/overlays/NewSession.js';
import { credential, fakeControlPlane } from './helpers/fakes.js';
import { KEY, inputReady, tick, waitFor, withTheme } from './helpers/ink.js';

const cpWith = (...names: string[]) =>
  fakeControlPlane({ listCredentials: async () => names.map((n) => credential(n)) });

function setup(cp = cpWith('a'), over: Partial<Parameters<typeof NewSessionOverlay>[0]> = {}) {
  const onCreate = vi.fn(() => new Promise<void>(() => undefined));
  const onBlocked = vi.fn();
  const r = render(
    withTheme(
      <NewSessionOverlay
        cp={cp}
        lastUsed={{}}
        presets={[]}
        onCreate={onCreate}
        onBlocked={onBlocked}
        onCancel={vi.fn()}
        {...over}
      />,
    ),
  );
  return { ...r, onCreate, onBlocked };
}

describe('NewSessionOverlay', () => {
  it('creates straight away with a single credential', async () => {
    const { onCreate, lastFrame } = setup();
    await waitFor(() => onCreate.mock.calls.length > 0, 1000, lastFrame);
    expect(onCreate).toHaveBeenCalledWith(
      { credentials: { inference: 'a' } },
      { inferenceCredential: 'a' },
    );
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toContain('creating session');
  });

  it('routes to credentials when there is none', async () => {
    const { onBlocked, lastFrame } = setup(cpWith());
    await waitFor(() => onBlocked.mock.calls.length > 0, 1000, lastFrame);
    expect(onBlocked).toHaveBeenCalledWith('add an inference credential to start');
    expect(onBlocked).toHaveBeenCalledTimes(1);
  });

  it('asks when there are several, preselecting the last used', async () => {
    const { stdin, onCreate, lastFrame } = setup(cpWith('a', 'b'), {
      lastUsed: { inferenceCredential: 'b' },
    });
    await waitFor(
      () => (lastFrame() ?? '').includes('Inference credential') && inputReady(stdin),
      1000,
      lastFrame,
    );
    expect(lastFrame()).toContain('Inference credential');
    stdin.write(KEY.enter);
    await waitFor(() => onCreate.mock.calls.length > 0, 1000, lastFrame);
    expect(onCreate).toHaveBeenCalledWith(
      { credentials: { inference: 'b' } },
      { inferenceCredential: 'b' },
    );
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('uses a preset, and notes preset fields the client no longer knows', async () => {
    const { stdin, onCreate, lastFrame } = setup(cpWith('a', 'b'), {
      presets: [{ name: 'work', values: { inferenceCredential: 'b', model: 'opus' } }],
    });
    await waitFor(() => (lastFrame() ?? '').includes('work') && inputReady(stdin), 1000, lastFrame);
    expect(lastFrame()).toContain('work');
    stdin.write(KEY.enter);
    await waitFor(() => onCreate.mock.calls.length > 0, 1000, lastFrame);
    expect(onCreate).toHaveBeenCalledWith(
      { credentials: { inference: 'b' } },
      { inferenceCredential: 'b' },
    );
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toContain('ignoring preset fields this version does not know: model');
  });

  it('shows a creation error', async () => {
    const onCreate = vi.fn(async () => {
      throw new Error('credential_required');
    });
    const { lastFrame } = setup(cpWith('a'), { onCreate });
    await waitFor(() => (lastFrame() ?? '').includes('credential_required'), 1000, lastFrame);
    expect(lastFrame()).toContain('credential_required');
  });

  it('shows credential labels with escape sequences stripped', async () => {
    const hostileName = 'evil\u001b]52;c;ZXZpbA==\u0007';
    const hostileEndpoint = 'https://x\u001b[8m.example';
    const cp = fakeControlPlane({
      listCredentials: async () => [
        credential(hostileName, { endpoint: hostileEndpoint }),
        credential('b'),
      ],
    });
    const { stdin, lastFrame } = setup(cp);
    await waitFor(() => (lastFrame() ?? '').includes('evil') && inputReady(stdin), 1000, lastFrame);
    expect(lastFrame()).not.toMatch(/\u001b|\u0007/);
    expect(lastFrame()).toContain('evil');
    expect(lastFrame()).toContain('https://x.example');
  });

  it('does not call onCreate if unmounted while credential listing is still pending', async () => {
    let resolveList: ((creds: CredentialDescriptor[]) => void) | undefined;
    const cp = fakeControlPlane({
      listCredentials: () =>
        new Promise<CredentialDescriptor[]>((resolve) => {
          resolveList = resolve;
        }),
    });
    const { unmount, onCreate } = setup(cp);
    await tick();
    expect(resolveList).toBeDefined();
    unmount();
    resolveList!([credential('a')]);
    await tick();
    expect(onCreate).not.toHaveBeenCalled();
  });
});
