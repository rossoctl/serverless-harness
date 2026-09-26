import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Paths } from './config.js';

export interface OsDeps {
  copy(text: string): Promise<void>;
  openUrl(url: string): void;
  editText(initial: string): string;
  openInEditor(file: string): void;
}

export function editorCommand(env: NodeJS.ProcessEnv): string {
  return env.VISUAL || env.EDITOR || 'vi';
}

/** The URL to hand the platform opener, or undefined unless it is plain http(s). */
export function openableUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

// The URL comes from the server (the device flow's verificationUri): anything but http(s) — a
// file: path, a custom scheme handler, a bare word `open` would treat as a file — is not opened.
export function openCommand(
  platform: NodeJS.Platform,
  raw: string,
): { cmd: string; args: string[] } | undefined {
  const url = openableUrl(raw);
  if (!url) return undefined;
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  return { cmd: 'xdg-open', args: [url] };
}

// The editor string is the user's own ($VISUAL/$EDITOR, which may carry flags such as
// `code --wait`), so it goes through the shell. The file path is ours, but it can still contain
// spaces (mkdtempSync(tmpdir()) is not guaranteed space-free) or shell metacharacters, and
// JSON.stringify quoting is not shell-safe for `$`/backticks — so instead of interpolating the
// path into the command string, it is passed as a positional argument to the shell rather than
// being interpolated:
//  - POSIX: `sh -c '<editor> "$1"' sh <file>` — 'sh' is the conventional $0 placeholder, <file>
//    lands in $1, quoted, so it survives as one word regardless of spaces or its content.
//  - win32: Node's `shell: true` picks cmd.exe; our own temp/export paths never contain a `"`,
//    so a plain double-quoted `"${file}"` is safe there.
//
// A missing or unstartable editor must not be silently swallowed: editText must not return the
// caller's untouched initial text as though the user had saved something. spawnSync never throws
// on its own, so its result is inspected here:
//  - `result.error` means the process itself (the shell, or cmd.exe) could not be started at all.
//  - `result.signal` means it was killed outright by a signal.
//  - on POSIX, a plain command-not-found/not-executable is reported by the *shell* as exit status
//    127/126 (since the editor runs as an argument to `sh -c`, not as the directly-spawned
//    program, so `result.error` is never set for that case) — these are treated as a start
//    failure too.
// An ordinary non-zero exit status is NOT an error (e.g. vim can exit 1 benignly) and is left
// alone.
function runEditor(env: NodeJS.ProcessEnv, file: string, platform: NodeJS.Platform): void {
  const editor = editorCommand(env);
  const result =
    platform === 'win32'
      ? spawnSync(`${editor} "${file}"`, { stdio: 'inherit', shell: true })
      : spawnSync('/bin/sh', ['-c', `${editor} "$1"`, 'sh', file], { stdio: 'inherit' });
  if (result.error) {
    throw new Error(`could not start editor "${editor}": ${result.error.message}`);
  }
  if (result.signal) {
    throw new Error(`editor "${editor}" was killed by signal ${result.signal}`);
  }
  if (platform !== 'win32' && (result.status === 126 || result.status === 127)) {
    throw new Error(
      `could not start editor "${editor}": command not found (exit ${result.status})`,
    );
  }
}

export function realOs(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): OsDeps {
  return {
    async copy(text) {
      const { default: clipboard } = await import('clipboardy');
      await clipboard.write(text);
    },
    openUrl(url) {
      const command = openCommand(platform, url);
      if (!command) return;
      const { cmd, args } = command;
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.on('error', () => undefined);
      child.unref();
    },
    editText(initial) {
      const dir = mkdtempSync(join(tmpdir(), 'mocactl-edit-'));
      const file = join(dir, 'prompt.md');
      try {
        writeFileSync(file, initial, { mode: 0o600 });
        runEditor(env, file, platform);
        return readFileSync(file, 'utf8').replace(/\n$/, '');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    openInEditor(file) {
      runEditor(env, file, platform);
    },
  };
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export function writeExport(paths: Paths, sessionId: string, markdown: string): string {
  if (!SAFE_ID.test(sessionId)) throw new Error(`refusing unsafe session id: ${sessionId}`);
  mkdirSync(paths.exportsDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.exportsDir, 0o700);
  const file = join(paths.exportsDir, `${sessionId}.md`);
  writeFileSync(file, markdown, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}
