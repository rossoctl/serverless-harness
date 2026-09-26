import { LoginCancelledError, apiTokenValid, deviceLogin, toCachedAuth } from './core/auth.js';
import { formatDiagnostics, runDiagnostics } from './core/diagnostics.js';
import { describeError } from './core/messages.js';
import { sanitizeRemote } from './core/sanitize.js';
import { SessionManager, type ActiveSession } from './core/session-manager.js';
import { SESSION_OPTION_FIELDS, resolveSessionOptions } from './core/session-options.js';
import { setAuth, type Runtime } from './runtime.js';

export interface Io {
  out(s: string): void;
  err(s: string): void;
}

// Only the control plane is required: it says where the harness is (GET /v1/discovery).
const MISSING = {
  controlPlaneUrl:
    'missing control-plane URL — pass --control-plane-url or set SH_CONTROL_PLANE_URL',
};

function missing(rt: Runtime, io: Io, need: Array<keyof typeof MISSING>): boolean {
  const absent = need.filter((k) => !rt.endpoints[k]);
  for (const k of absent) io.err(MISSING[k]);
  return absent.length > 0;
}

export async function cmdLogin(rt: Runtime, io: Io, signal?: AbortSignal): Promise<number> {
  if (missing(rt, io, ['controlPlaneUrl']) || !rt.cp) return 2;
  try {
    const login = await deviceLogin(
      { cp: rt.cp, sleep: rt.sleep, now: rt.now },
      (s) =>
        io.err(
          `Open ${sanitizeRemote(s.verificationUri)} and enter the code ${sanitizeRemote(s.userCode)}`,
        ),
      signal,
    );
    setAuth(rt, toCachedAuth(login, rt.endpoints.controlPlaneUrl!));
    io.err(`logged in as ${login.displayName ?? login.subject}`);
    return 0;
  } catch (err) {
    if (err instanceof LoginCancelledError) return 130;
    io.err(`login failed: ${describeError(err)}`);
    return 1;
  }
}

export async function cmdDoctor(rt: Runtime, io: Io, json: boolean): Promise<number> {
  if (missing(rt, io, ['controlPlaneUrl']) || !rt.cp || !rt.harness) return 2;
  const results = await runDiagnostics({
    cp: rt.cp,
    harness: rt.harness,
    controlPlaneUrl: rt.endpoints.controlPlaneUrl!,
    harnessOverridden: rt.endpoints.harnessUrl !== undefined,
    loggedIn: apiTokenValid(rt.auth, rt.now()),
  });
  io.out((json ? JSON.stringify(results) : formatDiagnostics(results)) + '\n');
  return results.every((r) => r.status === 'pass') ? 0 : 1;
}

export interface RunOptions {
  prompt: string;
  session?: string;
  options: Record<string, string>;
  json: boolean;
  signal?: AbortSignal;
}

export async function cmdRun(rt: Runtime, io: Io, opts: RunOptions): Promise<number> {
  if (missing(rt, io, ['controlPlaneUrl']) || !rt.cp || !rt.harness) return 2;
  if (!apiTokenValid(rt.auth, rt.now())) {
    io.err('not logged in — run `mocactl login` first');
    return 2;
  }
  const manager = new SessionManager({
    cp: rt.cp,
    harness: rt.harness,
    transcripts: rt.transcripts,
    now: rt.now,
    sleep: rt.sleep,
  });

  let session: ActiveSession;
  try {
    if (opts.session) {
      session = await manager.resume(opts.session);
    } else {
      const r = await resolveSessionOptions(
        rt.cp,
        SESSION_OPTION_FIELDS,
        opts.options,
        rt.config.lastUsed,
      );
      if (r.status === 'blocked') {
        io.err(`cannot start a session: ${r.field.emptyHint}`);
        return 2;
      }
      if (r.status === 'needs-input') {
        io.err(
          `choose the ${r.field.label.toLowerCase()} with --option ${r.field.key}=<value>: ${r.choices.map((c) => c.value).join(', ')}`,
        );
        return 2;
      }
      session = await manager.create(r.request);
    }
  } catch (err) {
    io.err(describeError(err));
    return 1;
  }

  io.err(`session ${session.sessionId}`);
  if (opts.json) io.out(JSON.stringify({ type: 'session', sessionId: session.sessionId }) + '\n');

  // A listener added to an already-aborted signal never fires, so a cancel that lands during
  // setup (resolveSessionOptions / create / resume, all above) would otherwise be missed and the
  // turn would run anyway. Check explicitly before submitting; the session itself stays intact
  // so the user can resume it.
  if (opts.signal?.aborted) return 130;

  type Outcome = 'done' | 'error' | 'cancelled';
  let outcome: Outcome = 'done';
  let failure: Error | undefined;
  session.on((e) => {
    if (e.kind === 'frame') {
      if (opts.json) io.out(JSON.stringify(e.frame) + '\n');
      // Plain text goes straight to a terminal; JSON output escapes control characters itself.
      else if (e.frame.type === 'text') io.out(sanitizeRemote(e.frame.delta));
    } else if (e.kind === 'retrying') {
      io.err(`the harness has no capacity — retrying in ${e.seconds}s`);
    } else if (e.kind === 'turn-end') {
      outcome = e.outcome;
      failure = e.error;
    }
  });
  opts.signal?.addEventListener('abort', () => session.cancel(), { once: true });
  session.submit(opts.prompt);
  await session.idle();

  if (!opts.json) io.out('\n');
  // `outcome` is reassigned inside the `session.on` closure above, which `session.idle()`
  // guarantees has already run by this point. TypeScript's control-flow narrowing can't see
  // through the closure boundary and treats `outcome` as still the literal 'done' here, so we
  // cast back to the declared union to read its real (possibly reassigned) value.
  if ((outcome as Outcome) === 'error') {
    io.err(describeError(failure));
    return 1;
  }
  return (outcome as Outcome) === 'cancelled' ? 130 : 0;
}
