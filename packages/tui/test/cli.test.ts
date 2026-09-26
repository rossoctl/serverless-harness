import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { USAGE, main } from '../src/cli.js';
import type { Io } from '../src/headless.js';
import type { Runtime } from '../src/runtime.js';

const io = (): Io & { outs: string[]; errs: string[] } => {
  const o = {
    outs: [] as string[],
    errs: [] as string[],
    out: (s: string) => void o.outs.push(s),
    err: (s: string) => void o.errs.push(s),
  };
  return o;
};
// `vi.fn` infers its mock's `.mock.calls` element type from the wrapped function's own
// parameter list. `buildRuntime`/`startInteractive` fakes below take rest params (rather than
// matching the real multi-arg signatures) purely so `.mock.calls[n][i]` type-checks when tests
// index into a specific call argument; the real call sites still pass their normal arguments.
const fakeBuild = (..._args: unknown[]) =>
  ({ endpoints: {}, config: {}, auth: null }) as unknown as Runtime;

describe('main', () => {
  it('prints usage for --help', async () => {
    const o = io();
    expect(await main(['--help'], {}, o, { buildRuntime: fakeBuild })).toBe(0);
    expect(o.outs.join('')).toContain(USAGE);
  });

  it('rejects an unknown command and an unknown flag', async () => {
    expect(await main(['frobnicate'], {}, io(), { buildRuntime: fakeBuild })).toBe(2);
    expect(await main(['--nope'], {}, io(), { buildRuntime: fakeBuild })).toBe(2);
  });

  it('requires a prompt for run and validates --option', async () => {
    expect(await main(['run'], {}, io(), { buildRuntime: fakeBuild })).toBe(2);
    const o = io();
    expect(await main(['run', 'hi', '--option', 'oops'], {}, o, { buildRuntime: fakeBuild })).toBe(
      2,
    );
    expect(o.errs.join('\n')).toContain('--option expects key=value');
  });

  it('accepts run --new, and rejects it together with --session', async () => {
    const run = vi.fn(async (..._args: unknown[]) => 0);
    const headless = await import('../src/headless.js');
    const spy = vi.spyOn(headless, 'cmdRun').mockImplementation(run);
    onTestFinished(() => spy.mockRestore());
    expect(await main(['run', 'hi', '--new'], {}, io(), { buildRuntime: fakeBuild })).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][2]).toMatchObject({ prompt: 'hi', session: undefined });
    const o = io();
    expect(
      await main(['run', 'hi', '--new', '--session', 's1'], {}, o, { buildRuntime: fakeBuild }),
    ).toBe(2);
    expect(o.errs.join('\n')).toContain('--new and --session cannot be used together');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('passes flags to the runtime builder', async () => {
    const build = vi.fn(fakeBuild);
    await main(
      ['doctor', '--control-plane-url', 'http://cp', '--harness-url', 'http://h'],
      {},
      io(),
      { buildRuntime: build },
    );
    expect(build.mock.calls[0][0]).toEqual({
      controlPlaneUrl: 'http://cp',
      harnessUrl: 'http://h',
    });
  });

  it('hands the no-command case to startInteractive', async () => {
    const start = vi.fn((..._args: unknown[]) => Promise.resolve(0));
    expect(
      await main(['--setup'], {}, io(), { buildRuntime: fakeBuild, startInteractive: start }),
    ).toBe(0);
    expect(start.mock.calls[0][1]).toEqual({ setup: true, noAnimation: false });
  });

  it('refuses the interactive UI without a terminal, pointing at run', async () => {
    const start = vi.fn((..._args: unknown[]) => Promise.resolve(0));
    const o = io();
    expect(
      await main([], {}, o, {
        buildRuntime: fakeBuild,
        startInteractive: start,
        stdinIsTTY: false,
      }),
    ).toBe(2);
    expect(start).not.toHaveBeenCalled();
    expect(o.errs.join('\n')).toContain('sh-tui run');
  });

  it('prints the config warning', async () => {
    const o = io();
    const build = () => ({ ...fakeBuild(), configWarning: 'ignoring unreadable x' }) as Runtime;
    await main(['frobnicate'], {}, o, { buildRuntime: build });
    expect(o.errs[0]).toBe('ignoring unreadable x');
  });
});
