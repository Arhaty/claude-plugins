/**
 * Hooks and scripts run with whatever Node the user has and nothing installed, so
 * they may import only Node's built-ins (as `node:` specifiers) and each other.
 * A package import would work on the author's machine, where `node_modules` exists,
 * and fail on every install.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative } from 'node:path';

import { ROOT, describe, expect, it } from './helpers.mjs';

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(mjs|js|cjs)$/.test(name)) yield path;
  }
}

/** Every module specifier in a source file: static, side-effect, re-export, dynamic and require. */
export function specifiers(source) {
  const patterns = [
    /\bimport\s+[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bexport\s+[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
    /\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((m) => m[1]));
}

const allowed = (spec) =>
  spec.startsWith('./') ||
  spec.startsWith('../') ||
  (spec.startsWith('node:') && builtinModules.includes(spec.slice(5).split('/')[0]));

describe('built-ins only', () => {
  const sources = ['hooks', 'scripts']
    .map((dir) => join(ROOT, dir))
    .filter((dir) => existsSync(dir))
    .flatMap((dir) => [...files(dir)]);

  it('finds the sources to check', () => {
    expect(sources.length).toBeGreaterThanOrEqual(8);
  });

  it.each(sources.map((path) => relative(ROOT, path)))(
    '%s imports only node: built-ins',
    (path) => {
      const bad = specifiers(readFileSync(join(ROOT, path), 'utf8')).filter(
        (spec) => !allowed(spec)
      );
      expect(bad).toEqual([]);
    }
  );

  it('catches every import form', () => {
    const source = [
      "import x from 'left-pad';",
      "import 'side-effect';",
      "export { y } from 'reexport';",
      "await import('dynamic');",
      "require('cjs');",
      "import fs from 'fs';",
      "import { a } from './local.mjs';",
      "import { b } from 'node:fs';",
    ].join('\n');
    expect(
      specifiers(source)
        .filter((spec) => !allowed(spec))
        .sort()
    ).toEqual(['cjs', 'dynamic', 'fs', 'left-pad', 'reexport', 'side-effect']);
  });
});
