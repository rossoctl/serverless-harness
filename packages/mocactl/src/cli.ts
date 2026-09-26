import { parseArgs } from 'node:util';
import { parseOptionFlags } from './core/session-options.js';
import { cmdDoctor, cmdLogin, cmdRun, type Io } from './headless.js';
import { buildRuntime, type Runtime } from './runtime.js';

export const USAGE = `usage:
  mocactl [--setup] [--no-animation]             interactive terminal UI
  mocactl login                                  log in with the GitHub device flow
  mocactl doctor [--json]                        check the setup; one fix per failure
  mocactl run "prompt" [--session ID | --new] [--option key=value ...] [--json]
flags for every command: --control-plane-url URL
  (the control plane says where the harness is; --harness-url URL overrides that)`;

export interface InteractiveOptions {
  setup: boolean;
  noAnimation: boolean;
}

export type StartInteractive = (rt: Runtime, opts: InteractiveOptions) => Promise<number>;

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: Io,
  deps: {
    buildRuntime?: typeof buildRuntime;
    startInteractive?: StartInteractive;
    signal?: AbortSignal;
    /** Whether stdin is a terminal; Ink needs raw mode, so the interactive UI refuses without one. */
    stdinIsTTY?: boolean;
  } = {},
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        'control-plane-url': { type: 'string' },
        'harness-url': { type: 'string' },
        session: { type: 'string' },
        new: { type: 'boolean' },
        option: { type: 'string', multiple: true },
        json: { type: 'boolean' },
        setup: { type: 'boolean' },
        'no-animation': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    io.err(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.out(USAGE + '\n');
    return 0;
  }

  const rt = (deps.buildRuntime ?? buildRuntime)(
    { controlPlaneUrl: values['control-plane-url'], harnessUrl: values['harness-url'] },
    env,
  );
  if (rt.configWarning) io.err(rt.configWarning);

  const [command, ...rest] = positionals;
  switch (command) {
    case 'login':
      return cmdLogin(rt, io, deps.signal);
    case 'doctor':
      return cmdDoctor(rt, io, values.json === true);
    case 'run': {
      const prompt = rest.join(' ').trim();
      if (!prompt) {
        io.err(USAGE);
        return 2;
      }
      // A new session is the default without --session; --new only says so explicitly.
      if (values.new && values.session !== undefined) {
        io.err(`--new and --session cannot be used together\n${USAGE}`);
        return 2;
      }
      let options: Record<string, string>;
      try {
        options = parseOptionFlags(values.option ?? []);
      } catch (err) {
        io.err((err as Error).message);
        return 2;
      }
      return cmdRun(rt, io, {
        prompt,
        session: values.session,
        options,
        json: values.json === true,
        signal: deps.signal,
      });
    }
    case undefined:
      if (!deps.startInteractive) {
        io.err('interactive mode is not wired yet');
        return 2;
      }
      if (deps.stdinIsTTY === false) {
        io.err('the interactive UI needs a terminal; for scripts use `mocactl run "prompt"`');
        return 2;
      }
      return deps.startInteractive(rt, {
        setup: values.setup === true,
        noAnimation: values['no-animation'] === true,
      });
    default:
      io.err(`unknown command "${command}"\n${USAGE}`);
      return 2;
  }
}
