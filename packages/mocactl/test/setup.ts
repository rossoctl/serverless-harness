import { afterEach } from 'vitest';
import { cleanup } from 'ink-testing-library';

// ink-testing-library's `render()` pushes every Ink instance into a module-level array that
// only its own `cleanup()` drains — nothing does that automatically. Without this, a render
// left mounted at the end of a test (its interval timers, in-flight AbortControllers, and
// input listeners all still live) survives into every later test in the same worker process,
// for the rest of the suite. Unmounting after each test keeps that from accumulating.
afterEach(() => {
  cleanup();
});
