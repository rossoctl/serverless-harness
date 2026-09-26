import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePaths } from '../src/config.js';
import { editorCommand, openCommand, realOs, writeExport } from '../src/os.js';

describe('editorCommand', () => {
  it('prefers VISUAL, then EDITOR, then vi', () => {
    expect(editorCommand({ VISUAL: 'code --wait', EDITOR: 'nano' })).toBe('code --wait');
    expect(editorCommand({ EDITOR: 'nano' })).toBe('nano');
    expect(editorCommand({})).toBe('vi');
  });
});

describe('openCommand', () => {
  it('uses the platform opener', () => {
    expect(openCommand('darwin', 'https://x')).toEqual({ cmd: 'open', args: ['https://x/'] });
    expect(openCommand('linux', 'https://x')).toEqual({ cmd: 'xdg-open', args: ['https://x/'] });
    expect(openCommand('win32', 'https://x')).toEqual({
      cmd: 'cmd',
      args: ['/c', 'start', '', 'https://x/'],
    });
  });
});

describe('openCommand with a server-supplied URL', () => {
  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'ssh://host',
    '/Applications/Calc.app',
    '',
  ])('opens nothing for %j', (url) => {
    expect(openCommand('darwin', url)).toBeUndefined();
    expect(openCommand('win32', url)).toBeUndefined();
    expect(openCommand('linux', url)).toBeUndefined();
  });

  it('still opens an http URL', () => {
    expect(openCommand('darwin', 'http://cp/login')).toEqual({
      cmd: 'open',
      args: ['http://cp/login'],
    });
  });
});

describe('editText', () => {
  it('returns what the editor saved, without the trailing newline', () => {
    // A fake "editor": a shell command that appends a line to the file it is given.
    const os = realOs({ EDITOR: 'sh -c \'printf "%s\\n" "$(cat "$0") edited" > "$0"\'' });
    expect(os.editText('draft')).toBe('draft edited');
  });

  it('throws instead of silently returning the initial text when the editor cannot be found', () => {
    const os = realOs({ EDITOR: 'definitely-not-an-editor-xyz' });
    expect(() => os.editText('draft')).toThrow(/could not start editor/i);
  });

  it('still removes its temp dir when the editor fails to start', () => {
    const os = realOs({ EDITOR: 'definitely-not-an-editor-xyz' });
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('mocactl-edit-')));
    expect(() => os.editText('draft')).toThrow();
    const leaked = readdirSync(tmpdir()).filter(
      (n) => n.startsWith('mocactl-edit-') && !before.has(n),
    );
    expect(leaked).toEqual([]);
  });

  it('throws when the editor process is killed by a signal', () => {
    // `#` comments out the file argument our own runEditor appends, so this just signals the
    // shell process spawnSync is watching directly.
    const os = realOs({ EDITOR: 'kill -TERM $$ #' });
    expect(() => os.editText('draft')).toThrow(/signal/i);
  });
});

describe('openInEditor', () => {
  it('passes a file path with a space and a literal $HOME as a single, unexpanded argument', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mocactl-os-'));
    const file = join(dir, 'a file $HOME name.md');
    writeFileSync(file, 'original');
    const recordFile = join(dir, 'argv.txt');
    // A fake "editor" that records the exact argument it was invoked with.
    const os = realOs({
      EDITOR: `sh -c 'printf "%s" "$0" > ${JSON.stringify(recordFile)}'`,
    });
    os.openInEditor(file);
    expect(readFileSync(recordFile, 'utf8')).toBe(file);
  });
});

describe('writeExport', () => {
  it('writes a private Markdown file under the exports directory', () => {
    const paths = resolvePaths({}, mkdtempSync(join(tmpdir(), 'mocactl-os-')));
    const file = writeExport(paths, 's1', '# hi\n');
    expect(file).toBe(join(paths.exportsDir, 's1.md'));
    expect(readFileSync(file, 'utf8')).toBe('# hi\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('refuses a session id that could escape the exports directory', () => {
    const paths = resolvePaths({}, mkdtempSync(join(tmpdir(), 'mocactl-os-')));
    expect(() => writeExport(paths, '../evil', '# hi\n')).toThrow(/unsafe/i);
    expect(() => writeExport(paths, 'a/b', '# hi\n')).toThrow(/unsafe/i);
  });
});
