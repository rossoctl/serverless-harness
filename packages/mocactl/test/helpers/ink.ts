import { createElement, type ReactNode } from 'react';
import { ThemeProvider } from '../../src/theme/context.js';
import { resolveTheme, type Theme } from '../../src/theme/tokens.js';

export const tick = (ms = 30) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Polls `condition` until it returns `true`, or throws with the last rendered frame once
 * `timeoutMs` elapses.
 *
 * Why this exists instead of a fixed `tick()` before writing a key: a fixed delay can't tell
 * the difference between "the view hasn't mounted yet" (e.g. `SelectList` behind an async
 * `listSessions()` call that's still pending under load) and "mounted, ready for input" — it
 * either under-waits and flakes, or over-waits and is slow. Waiting on observable frame
 * content instead fixes the first problem. It does NOT by itself fix the second: see
 * `inputReady` below, which every condition preceding a `stdin.write(...)` must also include.
 */
export async function waitFor(
  condition: () => boolean,
  timeoutMs = 1000,
  lastFrame?: () => string | undefined,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start >= timeoutMs) {
      const frame = lastFrame?.();
      throw new Error(
        `waitFor: condition did not become true within ${timeoutMs}ms` +
          (frame === undefined ? '' : `\n--- last frame ---\n${frame}\n------------------`),
      );
    }
    await tick(10);
  }
}

/**
 * True once Ink has actually subscribed to `stdin`'s `'readable'` event — i.e. once some
 * mounted `useInput` consumer's effect has run and a `stdin.write(...)` will be delivered
 * rather than silently dropped.
 *
 * This is NOT implied by the expected view already being on screen. Ink's `useInput` calls
 * `setRawMode(true)` (which attaches the `'readable'` listener) from a plain `useEffect`, and
 * React schedules passive effects on a later tick than the commit that painted the frame.
 * Confirmed by direct instrumentation: at the instant a freshly-mounted `SelectList`'s content
 * first appears in `lastFrame()`, `stdin.listenerCount('readable')` is reliably 0; it becomes 1
 * only after one more `tick(10)`, and a key written before that is dropped for good — Node's
 * `EventEmitter` does not replay an emit to a listener that attaches after it fired. This is
 * deterministic (reproduces every run, in isolation, not just under full-suite load), so a
 * dropped key here means "write happened before this became true," not "flaky terminal input."
 *
 * AND this into the `waitFor` condition that precedes every `stdin.write(...)`, especially
 * right after a component mount or swap (initial mount, or the list/confirm/form swap inside
 * `SessionsOverlay`). Once attached for a still-mounted component it stays attached for the
 * life of that instance, so later keystrokes handled by the same instance don't need to
 * recheck it — only the write immediately following a mount/swap does.
 */
export function inputReady(stdin: { listenerCount(event: string): number }): boolean {
  return stdin.listenerCount('readable') > 0;
}

export const KEY = {
  enter: '\r',
  escape: '\u001B',
  up: '\u001B[A',
  down: '\u001B[B',
  backspace: '\u007F',
  tab: '\t',
  ctrl: (letter: string) => String.fromCharCode(letter.toLowerCase().charCodeAt(0) - 96),
};

export function withTheme(node: ReactNode, theme: Theme = resolveTheme('system', {}, true)) {
  return createElement(ThemeProvider, { value: theme }, node);
}
