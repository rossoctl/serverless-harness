import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/errors.js';
import { OnboardingOverlay } from '../src/views/overlays/Onboarding.js';
import { credential, fakeControlPlane, fakeHarness } from './helpers/fakes.js';
import { KEY, inputReady, tick, waitFor, withTheme } from './helpers/ink.js';

const waitForAbort = (_ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => signal?.addEventListener('abort', () => r(), { once: true }));

function setup(
  over: {
    cp?: ReturnType<typeof fakeControlPlane>;
    harness?: ReturnType<typeof fakeHarness>;
    loggedIn?: boolean;
  } = {},
) {
  const cp =
    over.cp ?? fakeControlPlane({ listCredentials: async () => [credential('anthropic')] });
  const harness = over.harness ?? fakeHarness([]);
  const connect = vi.fn(() => ({ cp, harness }));
  const onDone = vi.fn();
  const r = render(
    withTheme(
      <OnboardingOverlay
        initial={{ controlPlaneUrl: 'http://cp', harnessUrl: 'http://h' }}
        connect={connect}
        hasValidLogin={() => over.loggedIn ?? true}
        loginDeps={() => ({ cp, now: () => 0, sleep: waitForAbort })}
        onLoggedIn={vi.fn()}
        onDone={onDone}
        onCancel={vi.fn()}
      />,
    ),
  );
  return { ...r, connect, onDone };
}

describe('OnboardingOverlay', () => {
  it('confirms a fully configured machine in two keypresses', async () => {
    const { stdin, lastFrame, connect, onDone } = setup();
    // The endpoints Form is the very first thing this overlay mounts; its useInput listener
    // attaches on its own effect-flush schedule (see test/helpers/ink.ts), so wait for it before
    // the first keystroke.
    await waitFor(
      () => inputReady(stdin) && (lastFrame() ?? '').includes('Control plane URL'),
      1000,
      lastFrame,
    );
    stdin.write(KEY.enter);
    await tick();
    // Same Form instance (Enter on a non-last field only moves focus — no unmount/remount), so
    // no need to recheck inputReady before the second Enter.
    stdin.write(KEY.enter);
    // The second Enter submits, which kicks off an async probe() that connects, health-checks
    // both endpoints, and then (already logged in, already has an inference credential) calls
    // onDone() — wait for that outcome rather than a fixed tick.
    await waitFor(() => onDone.mock.calls.length > 0, 1000, lastFrame);
    expect(connect).toHaveBeenCalledWith({ controlPlaneUrl: 'http://cp', harnessUrl: 'http://h' });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('stays on the endpoints step and names the endpoint that failed', async () => {
    const harness = fakeHarness([], {
      health: async () => {
        throw new ApiError('harness', 0, 'network_error', 'ECONNREFUSED');
      },
    });
    const { stdin, lastFrame, onDone } = setup({ harness });
    await waitFor(
      () => inputReady(stdin) && (lastFrame() ?? '').includes('Control plane URL'),
      1000,
      lastFrame,
    );
    stdin.write(KEY.enter);
    await tick();
    stdin.write(KEY.enter);
    // probe() fails, so the overlay unmounts the Form (probing step) and remounts a fresh one
    // (back to the endpoints step) with the error — wait for that text rather than a fixed tick.
    await waitFor(
      () => (lastFrame() ?? '').includes('harness: cannot reach the harness: ECONNREFUSED'),
      1000,
      lastFrame,
    );
    expect(onDone).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('Control plane URL');
  });

  it('rejects a URL that does not parse', async () => {
    const { stdin, lastFrame, connect } = setup();
    await waitFor(
      () => inputReady(stdin) && (lastFrame() ?? '').includes('Control plane URL'),
      1000,
      lastFrame,
    );
    // Single Form instance throughout (client-side validation blocks the submit before probe()
    // is ever called, so nothing unmounts) — Form's focus/value state is ref-backed (see
    // src/views/Form.tsx), so this burst of keystrokes is safe without a tick between each one.
    for (let i = 0; i < 20; i++) stdin.write(KEY.backspace);
    stdin.write('not a url');
    stdin.write(KEY.enter);
    stdin.write(KEY.enter);
    await tick();
    expect(connect).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('must be an http(s) URL');
  });

  it('goes to login when there is no valid login', async () => {
    const { stdin, lastFrame } = setup({ loggedIn: false });
    await waitFor(
      () => inputReady(stdin) && (lastFrame() ?? '').includes('Control plane URL'),
      1000,
      lastFrame,
    );
    stdin.write(KEY.enter);
    await tick();
    stdin.write(KEY.enter);
    // probe() succeeds but hasValidLogin() is false, so the overlay swaps in a freshly-mounted
    // LoginOverlay, which itself starts an async device-auth request — wait for its rendered code.
    await waitFor(() => (lastFrame() ?? '').includes('ABCD-1234'), 1000, lastFrame);
    expect(lastFrame()).toContain('ABCD-1234');
  });

  it('goes to the credential form when there is no inference credential', async () => {
    const { stdin, lastFrame, onDone } = setup({ cp: fakeControlPlane() });
    await waitFor(
      () => inputReady(stdin) && (lastFrame() ?? '').includes('Control plane URL'),
      1000,
      lastFrame,
    );
    stdin.write(KEY.enter);
    await tick();
    stdin.write(KEY.enter);
    // probe() succeeds, already logged in, but listCredentials() (default fakeControlPlane
    // resolves []) has no inference credential — the overlay swaps in a freshly-mounted
    // CredentialsOverlay with startInAdd, which renders its Form on its very first commit.
    await waitFor(() => (lastFrame() ?? '').includes('Add credential'), 1000, lastFrame);
    expect(onDone).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('Add credential');
    expect(lastFrame()).toContain('an inference credential is the key and gateway');
  });
});
