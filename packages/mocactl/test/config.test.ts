import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  clearAuth,
  loadAuth,
  loadConfig,
  normalizeUrl,
  resolveEndpoints,
  resolvePaths,
  saveAuth,
  saveConfig,
  type CachedAuth,
} from '../src/config.js';

const tmpHome = () => mkdtempSync(join(tmpdir(), 'mocactl-'));

describe('resolvePaths', () => {
  it('uses XDG dirs when set', () => {
    const p = resolvePaths({ XDG_CONFIG_HOME: '/c', XDG_STATE_HOME: '/s' }, '/home/u');
    expect(p.configFile).toBe('/c/mocactl/config.json');
    expect(p.authFile).toBe('/c/mocactl/auth.json');
    expect(p.transcriptsDir).toBe('/s/mocactl/transcripts');
    expect(p.exportsDir).toBe('/s/mocactl/exports');
  });

  it('falls back to ~/.config and ~/.local/state', () => {
    const p = resolvePaths({}, '/home/u');
    expect(p.configDir).toBe('/home/u/.config/mocactl');
    expect(p.stateDir).toBe('/home/u/.local/state/mocactl');
  });
});

describe('loadConfig / saveConfig', () => {
  it('returns defaults and exists=false when there is no file', () => {
    const paths = resolvePaths({}, tmpHome());
    expect(loadConfig(paths)).toEqual({ config: DEFAULT_CONFIG, exists: false });
  });

  it('round-trips and merges over defaults', () => {
    const paths = resolvePaths({}, tmpHome());
    saveConfig(paths, { ...DEFAULT_CONFIG, harnessUrl: 'http://h', theme: 'dark' });
    const { config, exists } = loadConfig(paths);
    expect(exists).toBe(true);
    expect(config.harnessUrl).toBe('http://h');
    expect(config.theme).toBe('dark');
    expect(config.presets).toEqual([]);
  });

  it('falls back to defaults with a warning on malformed JSON', () => {
    const paths = resolvePaths({}, tmpHome());
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(paths.configFile, '{ "theme": "dark", ');
    const loaded = loadConfig(paths);
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.exists).toBe(true);
    expect(loaded.warning).toMatch(/ignoring unreadable .*config\.json/);
  });

  it('rejects a JSON value that is not an object', () => {
    const paths = resolvePaths({}, tmpHome());
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(paths.configFile, '[1,2]');
    expect(loadConfig(paths).warning).toBeDefined();
  });
});

describe('loadConfig field validation', () => {
  const load = (body: unknown) => {
    const paths = resolvePaths({}, tmpHome());
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(paths.configFile, JSON.stringify(body));
    return loadConfig(paths);
  };

  it.each([
    ['keybinds', null],
    ['keybinds', { quit: 5 }],
    ['lastUsed', null],
    ['lastUsed', { inferenceCredential: 1 }],
    ['presets', null],
    ['presets', [{ name: 'p', values: null }]],
    ['presets', [{ values: {} }]],
    ['theme', 'neon'],
    ['details', 'yes'],
    ['bell', 1],
    ['controlPlaneUrl', 42],
  ])('replaces a bad %s (%j) with the default and names it in one warning', (key, value) => {
    const loaded = load({ [key]: value });
    expect(loaded.config[key as keyof typeof DEFAULT_CONFIG]).toEqual(
      DEFAULT_CONFIG[key as keyof typeof DEFAULT_CONFIG],
    );
    expect(loaded.warning).toMatch(new RegExp(`^ignoring invalid ${key} in .*config\\.json$`));
  });

  it('keeps the valid fields around the invalid ones and lists every invalid one', () => {
    const loaded = load({
      theme: 'dark',
      keybinds: null,
      presets: [{ name: 'p', values: { inferenceCredential: 'a' } }],
      lastUsed: null,
      extra: 'kept',
    });
    expect(loaded.config.theme).toBe('dark');
    expect(loaded.config.presets).toEqual([{ name: 'p', values: { inferenceCredential: 'a' } }]);
    expect(loaded.config.keybinds).toEqual({});
    expect(loaded.config.lastUsed).toEqual({});
    expect((loaded.config as unknown as Record<string, unknown>).extra).toBe('kept');
    expect(loaded.warning).toMatch(/^ignoring invalid keybinds, lastUsed in /);
  });

  it('gives no warning for a fully valid file', () => {
    expect(load({ theme: 'dark', keybinds: { quit: 'ctrl+q' } }).warning).toBeUndefined();
  });
});

describe('auth cache', () => {
  const auth: CachedAuth = {
    apiToken: 'tok', // notsecret
    subject: 'github:1',
    roles: [],
    expiresAt: 2_000_000_000,
    controlPlaneUrl: 'http://cp',
  };

  it('writes auth.json with mode 0600 in a 0700 directory', () => {
    const paths = resolvePaths({}, tmpHome());
    saveAuth(paths, auth);
    expect(statSync(paths.authFile).mode & 0o777).toBe(0o600);
    expect(statSync(paths.configDir).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(paths.authFile, 'utf8')).subject).toBe('github:1');
  });

  it('returns null for a different control plane', () => {
    const paths = resolvePaths({}, tmpHome());
    saveAuth(paths, auth);
    expect(loadAuth(paths, 'http://cp')?.apiToken).toBe('tok');
    expect(loadAuth(paths, 'http://other')).toBeNull();
  });

  it('clearAuth removes the file and is idempotent', () => {
    const paths = resolvePaths({}, tmpHome());
    saveAuth(paths, auth);
    clearAuth(paths);
    clearAuth(paths);
    expect(loadAuth(paths, 'http://cp')).toBeNull();
  });
});

describe('endpoints', () => {
  it('normalizes whitespace, empty strings and trailing slashes', () => {
    expect(normalizeUrl('  http://h/cp/  ')).toBe('http://h/cp');
    expect(normalizeUrl('')).toBeUndefined();
    expect(normalizeUrl(undefined)).toBeUndefined();
  });

  it('prefers flag over env over config', () => {
    const config = { ...DEFAULT_CONFIG, controlPlaneUrl: 'http://cfg', harnessUrl: 'http://cfg-h' };
    const env = { SH_CONTROL_PLANE_URL: 'http://env', SH_HARNESS_URL: '' };
    expect(resolveEndpoints({ controlPlaneUrl: 'http://flag/' }, env, config)).toEqual({
      controlPlaneUrl: 'http://flag',
      harnessUrl: 'http://cfg-h',
    });
    expect(resolveEndpoints({}, env, config).controlPlaneUrl).toBe('http://env');
  });
});
