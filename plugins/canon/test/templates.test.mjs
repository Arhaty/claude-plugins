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
      expect(claude).toMatch(/The spec's `\*\*Status:\*\*` line mirrors the issue\./);
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

  it('names the commit checks by command, leaving the build to the gate', () => {
    apply(root, {
      ...config(),
      commands: {
        ...config().commands,
        build: { command: 'pnpm build', env: { SITE_URL: 'http://localhost' } },
      },
    });
    const claude = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    expect(claude).toMatch(/run the checks: `pnpm typecheck`, `pnpm lint`, `pnpm test`\./);
    expect(claude).not.toMatch(/object Object|pnpm build/);
  });

  it('refuses a file the project spells in another case, writing nothing, until it is renamed', () => {
    mkdirSync(join(root, 'docs/canon'), { recursive: true });
    writeFileSync(join(root, 'docs/canon/_template.md'), 'ours\n');
    const step = plan(root, config()).find((s) => s.path === 'docs/canon/_TEMPLATE.md');
    expect(step.action).toBe('case');
    expect(step.wanted).toBe('docs/canon/_TEMPLATE.md');
    expect(step.variants).toEqual(['docs/canon/_template.md']);

    const result = apply(root, config(), { allow: ['docs/canon/_TEMPLATE.md'] });
    expect(result.ok).toBe(false);
    expect(result.cases).toEqual([
      { wanted: 'docs/canon/_TEMPLATE.md', variants: ['docs/canon/_template.md'] },
    ]);
    expect(readdirSync(join(root, 'docs/canon'))).toEqual(['_template.md']);
    expect(readFileSync(join(root, 'docs/canon/_template.md'), 'utf8')).toBe('ours\n');
    expect(existsSync(join(root, '.claude'))).toBe(false);

    const answers = join(tmpdir(), `canon-answers-${process.pid}.json`);
    writeFileSync(answers, JSON.stringify(config()));
    try {
      const cli = spawnSync(
        process.execPath,
        [join(ROOT, 'scripts/scaffold.mjs'), 'apply', '--root', root, '--answers', answers],
        { encoding: 'utf8' }
      );
      expect(cli.status).toBe(1);
      expect(cli.stderr).toMatch(/docs\/canon\/_template\.md -> docs\/canon\/_TEMPLATE\.md/);
    } finally {
      rmSync(answers);
    }
  });

  it('refuses a directory the project spells in another case, naming it once', () => {
    mkdirSync(join(root, '.Claude'));
    const steps = plan(root, config()).filter((s) => s.path.startsWith('.claude/'));
    expect(steps.length > 1).toBe(true);
    expect(steps.every((s) => s.action === 'case' && s.wanted === '.claude')).toBe(true);
    expect(apply(root, config()).cases).toEqual([{ wanted: '.claude', variants: ['.Claude'] }]);
  });

  it('refuses a canon index the project spells in another case', () => {
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.claude/Canon-Index.md'), 'ours\n');
    const result = apply(root, config());
    expect(result.ok).toBe(false);
    expect(result.cases).toEqual([
      { wanted: '.claude/canon-index.md', variants: ['.claude/Canon-Index.md'] },
    ]);
    expect(readdirSync(join(root, '.claude'))).toEqual(['Canon-Index.md']);
  });

  it('marks a specs README stale when the specs settings change, and still keeps it', () => {
    apply(root, config());
    const path = join(root, 'docs/specs/README.md');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n## Our own section\n`);
    const before = readFileSync(path, 'utf8');
    // An edited README under the same settings is the project's own, not stale.
    expect(plan(root, config()).find((s) => s.path === 'docs/specs/README.md').action).toBe('keep');
    const tracked = {
      ...config(),
      tracker: TRACKER,
      specs: { naming: 'branch', archive: 'tracker' },
    };
    const stale = plan(root, tracked).find((s) => s.path === 'docs/specs/README.md');
    expect(stale.action).toBe('stale');
    expect(stale.content).toMatch(/## Naming/);
    const allow = ['CLAUDE.md', '.claude/canon.json', 'docs/specs/_TEMPLATE.md'];
    expect(apply(root, tracked, { allow }).ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('shows a canon index in another case in the plan, not only in apply', () => {
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.claude/Canon-Index.md'), 'ours\n');
    const step = plan(root, config()).find((s) => s.path === '.claude/canon-index.md');
    expect(step.action).toBe('case');
  });

  it('numbers specs without an archive folder when the tracker is the archive', () => {
    apply(root, { ...config(), tracker: TRACKER, specs: { archive: 'tracker' } });
    const readme = readFileSync(join(root, 'docs/specs/README.md'), 'utf8');
    expect(readme).toMatch(/## Numbering/);
    expect(readme).not.toMatch(/archive\/|active and archive/);
    expect(readme).toMatch(/highest three-digit prefix ever committed under `docs\/specs\/`/);
    expect(readme).toMatch(/`abandoned` +\| Ada only +\| Dropped\. Not set: the spec is posted/);
    expect(readme).toMatch(/`\*\*Status:\*\*` line under the H1 is optional/);
  });

  it('names the issue as the spec argument whenever there is a tracker', () => {
    apply(root, { ...config(), tracker: TRACKER });
    const claude = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    expect(claude).toMatch(/`\/canon:build ABC-123`/);
    expect(claude).not.toMatch(/NNN`/);
  });

  it('writes the lifecycle table with its columns aligned, whatever fills it', () => {
    apply(root, { ...config(), specs: { commitWhileDrafting: false, archive: 'repo' } });
    const readme = readFileSync(join(root, 'docs/specs/README.md'), 'utf8');
    const rows = readme.split('\n').filter((line) => line.startsWith('|'));
    expect(rows.length).toBe(7);
    expect(new Set(rows.map((row) => row.length)).size).toBe(1);
  });

  it('requires the status line with a tracker unless the specs reference applies', () => {
    apply(root, { ...config(), tracker: TRACKER });
    const readme = readFileSync(join(root, 'docs/specs/README.md'), 'utf8');
    expect(readme).toMatch(/The status is the `\*\*Status:\*\*` line directly under the H1/);
  });

  it('describes an uncommitted draft when specs are not committed while drafting', () => {
    apply(root, { ...config(), specs: { commitWhileDrafting: false } });
    const readme = readFileSync(join(root, 'docs/specs/README.md'), 'utf8');
    expect(readme).toMatch(/Left uncommitted on its branch until `\/canon:approve` commits it/);
    expect(readme).not.toMatch(/each round/);
  });

  it('describes numbered specs archived in the repository by default', () => {
    apply(root, config());
    const claude = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    expect(claude).toMatch(/`NNN-slug\.md`\.\n {2}`archive\/` holds the rest\./);
    expect(claude).toMatch(/`\/canon:build NNN`/);
    expect(claude).toMatch(/`\/canon:staging`\*\* sets `shipped`, archives the spec, waits/);
    const readme = readFileSync(join(root, 'docs/specs/README.md'), 'utf8');
    expect(readme).toMatch(/## Numbering/);
    expect(readme).toMatch(/moves the spec to `archive\/`/);
    expect(readFileSync(join(root, 'docs/specs/_TEMPLATE.md'), 'utf8')).toMatch(/# NNN — /);
    expect(readme).toMatch(/Committed and pushed on its branch each round/);
  });

  it('describes branch-named specs archived to the tracker, with no archive folder', () => {
    apply(root, { ...config(), tracker: TRACKER, specs: { naming: 'branch', archive: 'tracker' } });
    const claude = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    expect(claude).toMatch(/`<branch>\.md`, the branch name with each `\/` as `-`\./);
    expect(claude).toMatch(/`\/canon:staging` posts it to its issue and deletes it/);
    expect(claude).toMatch(/`\/canon:build ABC-123`/);
    expect(claude).toMatch(/`\/canon:ship ABC-123`/);
    expect(claude).toMatch(/`\/canon:staging`\*\* posts the spec to its issue, deletes it, waits/);
    expect(claude).not.toMatch(/NNN|archive\/|archived|sets `shipped`/);
    expect(claude).toMatch(/the issue is the archive\. A spec/);
    expect(existsSync(join(root, 'docs/specs/archive'))).toBe(false);
    const readme = readFileSync(join(root, 'docs/specs/README.md'), 'utf8');
    expect(readme).toMatch(/`docs\/specs\/<branch>\.md`/);
    expect(readme).toMatch(/with each `\/` as `-`, on the branch that builds it\./);
    expect(claude).toMatch(/A spec's `\*\*Status:\*\*` line is optional; one that has it mirrors/);
    expect(readme).toMatch(/## Naming/);
    expect(readme).toMatch(/posts the spec to its issue as a comment, then deletes it/);
    expect(readme).not.toMatch(/NNN|archive\/|Numbering/);
    const template = readFileSync(join(root, 'docs/specs/_TEMPLATE.md'), 'utf8');
    expect(template).toMatch(/# <branch, each \/ as -> — /);
    expect(template).not.toMatch(/NNN/);
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
