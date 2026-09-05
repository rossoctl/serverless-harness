import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// `make typecheck` and CI both run `pnpm -r typecheck`, so the set of packages that
// actually gets typechecked is no longer a hand-maintained list in two files -- it is
// whichever packages declare the script. That closes the divergence of #191 but opens a
// quieter version of the same hole one level down: `pnpm -r <script>` SKIPS a package
// that does not declare the script, silently, and still exits 0. Before this suite
// existed, `pnpm -r typecheck` reported success while checking 2 of 9 packages.
//
// These checks are what make "the recursive run covers the repo" true rather than merely
// intended. Each one corresponds to a way a package can fall out of coverage:
//   1. it declares no `typecheck` script  -> pnpm skips it
//   2. it has no tsconfig.json at all     -> there is nothing for tsc to obey
//   3. its tsconfig omits `test`          -> its tests go unchecked (#190)

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The workspace members, read from pnpm-workspace.yaml rather than hardcoded -- a
 * hardcoded list here would be the very thing this suite exists to prevent.
 *
 * Deliberately a focused parser, not a YAML dependency: the file is a flat sequence of
 * quoted globs, and this throws loudly if it stops looking like that. A silently-empty
 * parse would make every assertion below vacuous, which is the one failure mode a
 * coverage guard must not have.
 */
function workspacePackageDirs(): string[] {
  const raw = readFileSync(resolve(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const patterns = [...raw.matchAll(/^\s*-\s*'([^']+)'\s*$/gm)].map((m) => m[1]!);
  if (patterns.length === 0) {
    throw new Error(
      'parsed zero package globs from pnpm-workspace.yaml -- reformatted (unquoted globs, ' +
        'block scalar)? Every assertion in this suite would pass vacuously.',
    );
  }

  const dirs: string[] = [];
  for (const pattern of patterns) {
    if (!pattern.includes('*')) {
      dirs.push(pattern);
      continue;
    }
    if (!pattern.endsWith('/*')) {
      throw new Error(`unsupported workspace glob '${pattern}' -- only 'dir/*' is handled`);
    }
    const parent = pattern.slice(0, -2);
    for (const entry of readdirSync(resolve(REPO_ROOT, parent), { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        existsSync(resolve(REPO_ROOT, parent, entry.name, 'package.json'))
      ) {
        dirs.push(join(parent, entry.name));
      }
    }
  }
  return dirs.sort();
}

/** Packages carrying TypeScript under src/ -- i.e. those that have something to typecheck. */
function packagesWithTypeScript(): string[] {
  return workspacePackageDirs().filter((dir) => {
    const src = resolve(REPO_ROOT, dir, 'src');
    if (!existsSync(src)) return false;
    return readdirSync(src, { recursive: true }).some(
      (f) => typeof f === 'string' && f.endsWith('.ts'),
    );
  });
}

const readJson = (...parts: string[]) =>
  JSON.parse(readFileSync(resolve(REPO_ROOT, ...parts), 'utf8'));

describe('typecheck coverage (what `pnpm -r typecheck` actually checks)', () => {
  it('finds the workspace packages it is supposed to be guarding', () => {
    // Guards the guard: if the parser or the src/ probe silently returned nothing, the
    // checks below would pass while asserting about an empty set.
    expect(packagesWithTypeScript().length).toBeGreaterThan(1);
  });

  it('gives every TypeScript package a tsconfig.json', () => {
    const missing = packagesWithTypeScript().filter(
      (dir) => !existsSync(resolve(REPO_ROOT, dir, 'tsconfig.json')),
    );
    expect(
      missing,
      'these packages ship TypeScript with no tsconfig.json, so no `tsc` invocation can ' +
        'check them however the recursive run is wired',
    ).toEqual([]);
  });

  it('gives every TypeScript package a `typecheck` script, so `pnpm -r` cannot skip it', () => {
    const missing = packagesWithTypeScript().filter(
      (dir) => !readJson(dir, 'package.json').scripts?.typecheck,
    );
    expect(
      missing,
      '`pnpm -r typecheck` skips a package that declares no such script and still exits 0 -- ' +
        'these packages would drop out of CI coverage without failing anything',
    ).toEqual([]);
  });

  it('includes `test` in every tsconfig, so tests are typechecked and not just src (#190)', () => {
    // This was harness/tsconfig.json's `"include": ["src"]`: the package typechecked green
    // while none of its 34 test files were looked at, so hand-built fakes had silently
    // drifted from the interfaces they claim to implement. A required field is only "a
    // compile error for a fourth implementation" if the fakes are compiled too.
    const uncovered = packagesWithTypeScript()
      .filter((dir) => existsSync(resolve(REPO_ROOT, dir, 'test')))
      .filter((dir) => {
        const include: unknown = readJson(dir, 'tsconfig.json').include;
        if (!Array.isArray(include)) {
          throw new Error(
            `${dir}/tsconfig.json has no \`include\` array -- this check cannot tell what it ` +
              'covers, and would otherwise pass it silently',
          );
        }
        return !include.some(
          (e) => e === 'test' || (typeof e === 'string' && e.startsWith('test/')),
        );
      });
    expect(
      uncovered,
      'these packages have a test/ directory their tsconfig does not include, so `tsc` reads ' +
        'only their src/',
    ).toEqual([]);
  });
});
