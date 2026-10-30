/**
 * The template smoke test: scaffold into a temp directory the way /canon:setup does,
 * and check every file arrives, no `{{placeholder}}` survives, and nothing that
 * exists is overwritten without an explicit allow.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { trustKey, validate } from '../hooks/lib/config.mjs';
import { apply, fill, plan } from '../scripts/scaffold.mjs';
import { CONFIG, ROOT, TRACKER, afterEach, beforeEach, describe, expect, it } from './helpers.mjs';

const EXPECTED = [
  'CLAUDE.md',
  '.claude/canon.json',
  '.claude/canon-domains.json',
  '.claude/canon-index.md',
  '.claude/rules/principles.md',
  'docs/canon/README.md',
  'docs/canon/_TEMPLATE.md',
  'docs/specs/README.md',
  'docs/specs/_TEMPLATE.md',
  'docs/specs/archive/.gitkeep',
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

const config = () => ({
  ...structuredClone(CONFIG),
  commands: { typecheck: 'pnpm typecheck', lint: 'pnpm lint', format: null, test: 'pnpm test' },
});

describe('scaffold', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'canon-scaffold-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('writes every project file into an empty directory', () => {
    expect(apply(root, config()).ok).toBe(true);
    for (const path of EXPECTED) expect(existsSync(join(root, path)), path).toBe(true);
  });

  it('leaves no {{placeholder}} in any file', () => {
    apply(root, config(), { enablePlugin: true });
    const left = [...walk(root)].filter((file) =>
      /\{\{\s*\w+\s*\}\}/.test(readFileSync(file, 'utf8'))
    );
    expect(left).toEqual([]);
  });

  it('fills the values from the config', () => {
    apply(root, config());
    const claude = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    expect(claude).toMatch(/`origin\/staging`/);
    expect(claude).toMatch(/merged by Ada and nobody else/);
    expect(claude).toMatch(/`pnpm typecheck`, `pnpm lint`, `pnpm test`/);
    expect(claude).toMatch(/`feat\/`, `fix\/`/);
  });

  it('writes a canon.json the hooks accept, pointing at the schema', () => {
    apply(root, config());
    const written = JSON.parse(readFileSync(join(root, '.claude/canon.json'), 'utf8'));
    expect(written.$schema).toMatch(/canon\.schema\.json$/);
    delete written.$schema;
    expect(validate(written)).toEqual([]);
  });

  it('refuses to overwrite an existing file, writing nothing, until it is allowed', () => {
    writeFileSync(join(root, 'CLAUDE.md'), '# Mine\n\nKeep this.\n');
    const refused = apply(root, config());
    expect(refused.ok).toBe(false);
    expect(refused.refused).toEqual(['CLAUDE.md']);
    expect(existsSync(join(root, 'docs/canon/README.md'))).toBe(false);

    expect(apply(root, config(), { allow: ['CLAUDE.md'] }).ok).toBe(true);
    const claude = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    expect(claude).toMatch(/^# Mine\n\nKeep this\.\n\n<!-- canon:begin -->/);
  });

  it('replaces only its own CLAUDE.md section on a second run', () => {
    apply(root, config());
    writeFileSync(
      join(root, 'CLAUDE.md'),
      `${readFileSync(join(root, 'CLAUDE.md'), 'utf8')}\n## After\n`
    );
    const changed = { ...config(), owner: 'Grace' };
    const steps = plan(root, changed);
    expect(steps.find((s) => s.path === 'CLAUDE.md').action).toBe('conflict');
    const allow = steps.filter((s) => s.action === 'conflict').map((s) => s.path);
    expect(apply(root, changed, { allow }).ok).toBe(true);
    const claude = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    expect(claude.match(/canon:begin/g).length).toBe(1);
    expect(claude).toMatch(/Grace/);
    expect(claude).toMatch(/## After/);
  });

  it('is idempotent: a second run with the same answers changes nothing', () => {
    apply(root, config(), { enablePlugin: true });
    const steps = plan(root, config(), { enablePlugin: true });
    const changed = steps.filter((s) => s.action !== 'same' && s.action !== 'keep');
    expect(changed.map((s) => s.path)).toEqual([]);
  });

  it('merges the plugin key into existing settings without touching the rest', () => {
    apply(root, config());
    writeFileSync(
      join(root, '.claude/settings.json'),
      JSON.stringify({ permissions: { allow: ['Read'] } })
    );
    expect(apply(root, config(), { enablePlugin: true }).ok).toBe(false);
    apply(root, config(), { enablePlugin: true, allow: ['.claude/settings.json'] });
    expect(JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'))).toEqual({
      permissions: { allow: ['Read'] },
      enabledPlugins: { 'canon@arhaty': true },
    });
  });

  it('keeps an existing domain map and index READMEs rather than offering to replace them', () => {
    const mine = {
      '.claude/canon-domains.json': '{ "auth.md": ["src/auth/"] }\n',
      'docs/canon/README.md': '# Our canon\n',
      'docs/specs/README.md': '# Our specs\n',
    };
    for (const [path, content] of Object.entries(mine)) {
      mkdirSync(join(root, dirname(path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const steps = plan(root, config());
    for (const path of Object.keys(mine)) {
      expect(steps.find((s) => s.path === path).action, path).toBe('keep');
    }
    expect(apply(root, config()).ok).toBe(true);
    for (const [path, content] of Object.entries(mine)) {
      expect(readFileSync(join(root, path), 'utf8'), path).toBe(content);
    }
  });

  it('refuses to write through a symlink, writing nothing', () => {
    const outside = mkdtempSync(join(tmpdir(), 'canon-outside-'));
    symlinkSync(outside, join(root, '.claude'));
    const steps = plan(root, config());
    expect(steps.find((s) => s.path === '.claude/canon.json').action).toBe('symlink');
    const result = apply(root, config());
    expect(result.ok).toBe(false);
    expect(result.symlinks).toEqual(['.claude']);
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(root, 'docs'))).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it('refuses a dangling symlink, writing nothing', () => {
    symlinkSync(join(root, 'nowhere.md'), join(root, 'CLAUDE.md'));
    const result = apply(root, config());
    expect(result.ok).toBe(false);
    expect(result.symlinks).toEqual(['CLAUDE.md']);
    expect(existsSync(join(root, 'nowhere.md'))).toBe(false);
    expect(existsSync(join(root, '.claude'))).toBe(false);
  });

  it('writes through a symlink that stays inside the project', () => {
    writeFileSync(join(root, 'AGENTS.md'), '# Agents\n');
    symlinkSync('AGENTS.md', join(root, 'CLAUDE.md'));
    expect(plan(root, config()).find((s) => s.path === 'CLAUDE.md').action).toBe('conflict');
    expect(apply(root, config(), { allow: ['CLAUDE.md'] }).ok).toBe(true);
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toMatch(
      /^# Agents\n\n<!-- canon:begin -->/
    );
  });

  it('refuses a symlinked canon-index.md in the index writer', () => {
    apply(root, config());
    const target = join(tmpdir(), `canon-index-target-${process.pid}.md`);
    writeFileSync(target, 'theirs\n');
    rmSync(join(root, '.claude/canon-index.md'));
    symlinkSync(target, join(root, '.claude/canon-index.md'));
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts/canon-index.mjs'), root], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/symlink/);
    expect(readFileSync(target, 'utf8')).toBe('theirs\n');
    rmSync(target);
  });

  it('says what is wrong with an invalid settings.json instead of crashing', () => {
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude/settings.json'), '{ "permissions": ');
    expect(() => plan(root, config(), { enablePlugin: true })).toThrow();
    const answers = join(root, 'answers.json');
    writeFileSync(answers, JSON.stringify(config()));
    const result = spawnSync(
      process.execPath,
      [
        join(ROOT, 'scripts/scaffold.mjs'),
        'plan',
        '--root',
        root,
        '--answers',
        answers,
        '--enable-plugin',
      ],
      { encoding: 'utf8' }
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^scaffold: \.claude\/settings\.json is not valid JSON/);
    expect(result.stderr).not.toMatch(/at \w+ \(/);
  });

  it('records the formatter approval outside the project with trust', () => {
    const home = mkdtempSync(join(tmpdir(), 'canon-home-'));
    const answers = join(root, 'answers.json');
    const argv = ['pnpm', 'exec', 'prettier', '--write'];
    writeFileSync(answers, JSON.stringify({ ...config(), formatFile: argv }));
    const result = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts/scaffold.mjs'), 'trust', '--root', root, '--answers', answers],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          CANON_TEST_HOME: home,
          NODE_OPTIONS: `--import=${pathToFileURL(join(ROOT, 'test/fake-home.mjs'))}`,
        },
      }
    );
    expect(result.status).toBe(0);
    const stored = JSON.parse(readFileSync(join(home, '.claude/canon/trusted.json'), 'utf8'));
    expect(stored[trustKey(root)].formatFile).toEqual(argv);
    expect(existsSync(join(root, '.claude'))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  it('writes the tracker paragraph only for a project with a tracker', () => {
    apply(root, config());
    const plain = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    expect(plain).not.toMatch(/Linear|canon: blocked|Fixes /);
    expect(plain).toMatch(/update the spec first\.\n\n### Branches and commits/);

    const other = mkdtempSync(join(tmpdir(), 'canon-scaffold-'));
    try {
      apply(other, { ...config(), tracker: TRACKER });
      const claude = readFileSync(join(other, 'CLAUDE.md'), 'utf8');
      expect(claude).toMatch(/update the spec first\.\n\n### Linear\n\nLinear team `ABC`/);
      expect(claude).toMatch(/from `Todo` to `In Spec`/);
      expect(claude).toMatch(/`<prefix>\/abc-123-<slug>`/);
      expect(claude).toMatch(/`Fixes ABC-123`/);
      expect(claude).toMatch(/re-run the command\.\n\n### Branches and commits/);
      const written = JSON.parse(readFileSync(join(other, '.claude/canon.json'), 'utf8'));
      expect(written.tracker).toEqual(TRACKER);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('names branches the way the config does', () => {
    apply(root, {
      ...config(),
      branches: { integration: 'staging', production: 'main', naming: 'tracker' },
      tracker: TRACKER,
    });
    const claude = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    expect(claude).toMatch(/Branch names: the tracker issue's own branch name, verbatim\./);
    expect(claude).toMatch(
      /Branches are the issue's own branch name, verbatim, e\.g\. `abc-123-<slug>`/
    );
    expect(claude).not.toMatch(/<prefix>/);
  });

  it('records an approved API key command from a partial answers file', () => {
    const home = mkdtempSync(join(tmpdir(), 'canon-home-'));
    const answers = join(root, 'answers.json');
    const argv = ['op', 'read', 'op://Vault/Item/field'];
    const trustCli = (...extra) =>
      spawnSync(
        process.execPath,
        [
          join(ROOT, 'scripts/scaffold.mjs'),
          'trust',
          '--root',
          root,
          '--answers',
          answers,
          ...extra,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            CANON_TEST_HOME: home,
            NODE_OPTIONS: `--import=${pathToFileURL(join(ROOT, 'test/fake-home.mjs'))}`,
          },
        }
      );
    try {
      // Setup lists the team's statuses before the rest of the config exists.
      writeFileSync(
        answers,
        JSON.stringify({ tracker: { provider: 'linear', team: 'ABC', apiKeyCommand: argv } })
      );
      const result = trustCli('--command', 'apiKeyCommand');
      expect(result.status, result.stderr).toBe(0);
      const stored = JSON.parse(readFileSync(join(home, '.claude/canon/trusted.json'), 'utf8'));
      expect(stored[trustKey(root)].apiKeyCommand).toEqual(argv);
      expect(stored[trustKey(root)].formatFile).toBeUndefined();

      // The formatter still needs a whole valid config, and an unknown kind is refused.
      expect(trustCli().status).toBe(2);
      expect(trustCli('--command', 'anything').status).toBe(2);
      writeFileSync(answers, JSON.stringify({ tracker: { apiKeyCommand: ['op', ''] } }));
      expect(trustCli('--command', 'apiKeyCommand').status).toBe(2);
      writeFileSync(answers, JSON.stringify({ tracker: {} }));
      expect(trustCli('--command', 'apiKeyCommand').status).toBe(1);

      // A command that names the repository, or a relative program, is never approved.
      writeFileSync(
        answers,
        JSON.stringify({ tracker: { apiKeyCommand: ['sh', join(root, 'key.sh')] } })
      );
      const refused = trustCli('--command', 'apiKeyCommand');
      expect(refused.status).toBe(2);
      expect(refused.stderr).toMatch(/names this repository's path/);
      writeFileSync(answers, JSON.stringify({ tracker: { apiKeyCommand: ['./key.sh'] } }));
      expect(trustCli('--command', 'apiKeyCommand').stderr).toMatch(/not a relative path/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('throws on an unknown placeholder rather than shipping it', () => {
    expect(() => fill('{{nope}}', {})).toThrow();
  });

  it('runs as a CLI: plan, refuse, apply', () => {
    const answers = join(root, 'answers.json');
    writeFileSync(answers, JSON.stringify(config()));
    const project = join(root, 'p');
    const cli = (...args) =>
      spawnSync(
        process.execPath,
        [join(ROOT, 'scripts/scaffold.mjs'), ...args, '--root', project, '--answers', answers],
        {
          encoding: 'utf8',
        }
      );
    const planned = cli('plan', '--json');
    expect(planned.status).toBe(0);
    expect(JSON.parse(planned.stdout).every((s) => s.action === 'create')).toBe(true);
    expect(cli('apply').status).toBe(0);
    expect(existsSync(join(project, '.claude/canon-index.md'))).toBe(true);
    writeFileSync(answers, JSON.stringify({ ...config(), owner: '' }));
    const bad = cli('plan');
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/owner/);
  });
});
