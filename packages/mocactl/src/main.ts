import { main } from './cli.js';

const ac = new AbortController();
process.once('SIGINT', () => ac.abort());

process.exitCode = await main(
  process.argv.slice(2),
  process.env,
  { out: (s) => void process.stdout.write(s), err: (s) => void process.stderr.write(s + '\n') },
  {
    signal: ac.signal,
    stdinIsTTY: process.stdin.isTTY === true,
    // Loaded lazily so the headless commands never load Ink or React.
    startInteractive: async (rt, opts) => (await import('./start.js')).startInteractive(rt, opts),
  },
);
