import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/errors.js';
import { CredentialsOverlay } from '../src/views/overlays/Credentials.js';
import { credential, fakeControlPlane } from './helpers/fakes.js';
import { KEY, inputReady, tick, waitFor, withTheme } from './helpers/ink.js';

async function type(stdin: { write: (s: string) => void }, ...chunks: string[]) {
  for (const c of chunks) {
    stdin.write(c);
    await tick();
  }
}

describe('CredentialsOverlay', () => {
  it('lists credential metadata, never values', async () => {
    const cp = fakeControlPlane({ listCredentials: async () => [credential('anthropic')] });
    const { lastFrame } = render(withTheme(<CredentialsOverlay cp={cp} onCancel={vi.fn()} />));
    await waitFor(() => (lastFrame() ?? '').includes('anthropic'), 1000, lastFrame);
    expect(lastFrame()).toContain('anthropic');
    expect(lastFrame()).toContain('bearer · inference · https://anthropic.example/v1');
  });

  it('shows server credential metadata with its escape sequences stripped', async () => {
    const cp = fakeControlPlane({
      listCredentials: async () => [
        credential('evil\u001b]52;c;c2VjcmV0\u0007', { endpoint: 'https://x\u001b[8m.example' }),
      ],
    });
    const { lastFrame } = render(withTheme(<CredentialsOverlay cp={cp} onCancel={vi.fn()} />));
    await waitFor(() => (lastFrame() ?? '').includes('evil'), 1000, lastFrame);
    expect(lastFrame()).not.toMatch(/\u001b\]|\u001b\[8m|\u0007|c2VjcmV0/);
    expect(lastFrame()).toContain('https://x.example');
  });

  it('hands an expired login to the host instead of showing an error screen', async () => {
    const expired = new ApiError('control-plane', 401, 'token_expired');
    const cp = fakeControlPlane({
      listCredentials: async () => {
        throw expired;
      },
    });
    const onError = vi.fn(() => true);
    const { lastFrame } = render(
      withTheme(<CredentialsOverlay cp={cp} onCancel={vi.fn()} onError={onError} />),
    );
    await waitFor(() => onError.mock.calls.length > 0, 1000, lastFrame);
    expect(onError).toHaveBeenCalledWith(expired);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(lastFrame()).not.toContain('login has expired');
  });

  it('adds a credential and returns to the list', async () => {
    const put = vi.fn(async () => undefined);
    const onChanged = vi.fn();
    const cp = fakeControlPlane({ putCredential: put });
    const { stdin, lastFrame } = render(
      withTheme(<CredentialsOverlay cp={cp} onChanged={onChanged} onCancel={vi.fn()} />),
    );
    // Initial SelectList mounts once listCredentials() resolves; wait for its content and for
    // useInput to attach before the first write (see test/helpers/ink.ts).
    await waitFor(
      () => (lastFrame() ?? '').includes('no credentials yet') && inputReady(stdin),
      1000,
      lastFrame,
    );
    stdin.write('a');
    // 'a' swaps the list for a freshly-mounted Form; wait for its heading and its own
    // useInput attach before typing into it.
    await waitFor(
      () => (lastFrame() ?? '').includes('Add credential') && inputReady(stdin),
      1000,
      lastFrame,
    );
    // name, kind (default), consumer (default), hosts (required — must type one), endpoint
    // (skip), token
    await type(
      stdin,
      'mine',
      KEY.enter,
      KEY.enter,
      KEY.enter,
      'api.anthropic.com',
      KEY.enter,
      KEY.enter,
      'sk-1',
      KEY.enter,
    );
    await waitFor(() => (lastFrame() ?? '').includes('Credentials'), 1000, lastFrame);
    expect(put).toHaveBeenCalledWith('mine', {
      kind: 'bearer',
      consumer: 'inference',
      destination: { hosts: ['api.anthropic.com'] },
      secret: { token: 'sk-1' },
    }); // notsecret
    expect(put).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toContain('Credentials');
  });

  it('shows the server validation message inside the form', async () => {
    const cp = fakeControlPlane({
      putCredential: async () => {
        throw new ApiError(
          'control-plane',
          400,
          'invalid_request',
          "kind 'bearer' requires secret fields: token",
        );
      },
    });
    const { stdin, lastFrame } = render(
      withTheme(<CredentialsOverlay cp={cp} startInAdd onCancel={vi.fn()} />),
    );
    // startInAdd renders the Form on the very first commit, but its useInput still attaches on
    // its own effect-flush schedule.
    await waitFor(
      () => (lastFrame() ?? '').includes('Add credential') && inputReady(stdin),
      1000,
      lastFrame,
    );
    await type(
      stdin,
      'mine',
      KEY.enter,
      KEY.enter,
      KEY.enter,
      'api.anthropic.com',
      KEY.enter,
      KEY.enter,
      'x',
      KEY.enter,
    );
    await waitFor(
      () => (lastFrame() ?? '').includes("kind 'bearer' requires secret fields: token"),
      1000,
      lastFrame,
    );
    expect(lastFrame()).toContain("kind 'bearer' requires secret fields: token");
    // The Form instance survives the failed submit (same component identity, not remounted), so
    // the name typed before submitting is still visible — the user isn't asked to retype it.
    expect(lastFrame()).toContain('mine');
  });

  it('deletes after confirmation', async () => {
    const del = vi.fn(async () => undefined);
    const cp = fakeControlPlane({
      listCredentials: async () => [credential('old')],
      deleteCredential: del,
    });
    const { stdin, lastFrame } = render(
      withTheme(<CredentialsOverlay cp={cp} onCancel={vi.fn()} />),
    );
    await waitFor(() => (lastFrame() ?? '').includes('old') && inputReady(stdin), 1000, lastFrame);
    stdin.write('d');
    // 'd' swaps the list for a freshly-mounted Confirm; wait for its prompt and its own
    // useInput attach before writing 'y'.
    await waitFor(
      () => (lastFrame() ?? '').includes('Delete credential "old"?') && inputReady(stdin),
      1000,
      lastFrame,
    );
    stdin.write('y');
    await waitFor(() => del.mock.calls.length > 0, 1000, lastFrame);
    expect(del).toHaveBeenCalledWith('old');
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('shows the delete confirmation with escape sequences stripped from the name', async () => {
    const hostileName = 'evil\u001b]52;c;ZXZpbA==\u0007\u001b[8m';
    const cp = fakeControlPlane({
      listCredentials: async () => [credential(hostileName)],
    });
    const { stdin, lastFrame } = render(
      withTheme(<CredentialsOverlay cp={cp} onCancel={vi.fn()} />),
    );
    await waitFor(() => (lastFrame() ?? '').includes('evil') && inputReady(stdin), 1000, lastFrame);
    stdin.write('d');
    await waitFor(
      () => (lastFrame() ?? '').includes('Delete credential') && inputReady(stdin),
      1000,
      lastFrame,
    );
    expect(lastFrame()).not.toMatch(/\u001b|\u0007/);
    expect(lastFrame()).toContain(`Delete credential "evil"?`);
  });

  it('shows the contextual hint it was opened with', async () => {
    const { lastFrame } = render(
      withTheme(
        <CredentialsOverlay
          cp={fakeControlPlane()}
          hint="add an inference credential to start"
          onCancel={vi.fn()}
        />,
      ),
    );
    await waitFor(
      () => (lastFrame() ?? '').includes('add an inference credential to start'),
      1000,
      lastFrame,
    );
    expect(lastFrame()).toContain('add an inference credential to start');
  });
});
