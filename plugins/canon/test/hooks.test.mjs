/**
 * The hooks run end to end, as Claude Code runs them: a JSON payload on stdin, a stub
 * `gh` (and sometimes `git`) on PATH, and a scratch project with its own
 * `.claude/canon.json`. Exit 0 allows the call, exit 2 refuses it.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CONFIG,
  HOOKS,
  ROOT,
  afterEach,
  beforeEach,
  brokenHooks,
  describe,
  expect,
  it,
  makeProject,
  run,
  runHook,
  scratchRepo,
} from './helpers.mjs';

const MERGE = 'gh pr merge 5 --merge --delete-branch';
const into = (base, number = 5) => `echo '{"baseRefName":"${base}","number":${number}}'`;

/** A stub `gh` answering both reads `require-canon.mjs` makes: the pull request, then its files. */
const pr = (base, files, number = 57) =>
  `case "$*" in *files*) printf '%s\\n' ${files.map((f) => `'${f}'`).join(' ')};; ` +
  `*) echo '{"baseRefName":"${base}","number":${number},"url":"https://github.com/o/r/pull/${number}"}';; esac`;

const MCP = {
  tool_name: 'mcp__github__merge_pull_request',
  tool_input: { owner: 'o', repo: 'r', pullNumber: 12 },
};

/** Landing on `main` with no pull request, from both source suites. */
const DIRECT = [
  'gh api repos/{owner}/{repo}/merges -f base=main -f head=staging',
  'gh api -X POST repos/o/r/merges -f head=x -F base=refs/heads/main',
  'gh api https://api.github.com/repos/o/r/merges --field=base=main -f head=x',
  'gh api -X PATCH repos/{owner}/{repo}/git/refs/heads/main -f sha=abc -F force=true',
  'gh api repos/{owner}/{repo}/git/refs/heads/main -f sha=abc',
  'gh api -X PUT repos/o/r/git/refs/heads/main -f sha=abc',
  'gh api -X DELETE https://api.github.com/repos/o/r/git/refs/heads/main',
  'gh api -X DELETE /repos/o/r/git/refs/heads/main/',
  'gh api repos/o/r/merges --input body.json',
  'gh api repos/o/r/merges -f base="$base" -f head=x',
  'gh api repos/o/r/merges -F base=@base.txt -f head=x',
  'gh api -X PATCH repos/{owner}/{repo}/git/refs/heads/{branch} -f sha=abc',
];

describe('protect-merge', () => {
  it('fails closed when the pull request cannot be read', () => {
    expect(runHook('protect-merge.mjs', MERGE, 'exit 1')).toBe(2);
  });

  it('fails closed when gh hangs past the deadline', () => {
    // Longer than the 15 seconds the reads get. `exec`, so the timeout kills the sleep itself
    // rather than a shell whose child still holds the pipe open.
    const started = Date.now();
    expect(runHook('protect-merge.mjs', MERGE, 'exec sleep 30')).toBe(2);
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 25_000);

  it('blocks a merge into production and allows one into integration', () => {
    expect(runHook('protect-merge.mjs', MERGE, into('main'))).toBe(2);
    expect(runHook('protect-merge.mjs', MERGE, into('staging'))).toBe(0);
    expect(runHook('protect-merge.mjs', 'bash -c "gh pr merge 1"', into('main'))).toBe(2);
  });

  it('reads the production branch from canon.json', () => {
    const project = makeProject({
      config: {
        ...CONFIG,
        branches: { ...CONFIG.branches, integration: 'dev', production: 'live' },
      },
    });
    const merge = (gh) => run('protect-merge.mjs', MERGE, gh, { project }).status;
    expect(merge(into('live'))).toBe(2);
    expect(merge(into('main'))).toBe(0);
    expect(merge(into('dev'))).toBe(0);
    const { stderr } = run('protect-merge.mjs', MERGE, into('live'), { project });
    expect(stderr).toMatch(/`live`/);
    expect(stderr).toMatch(/Ada/);
    rmSync(project, { recursive: true, force: true });
  });

  it('fails closed on another repository and on a selector it cannot evaluate', () => {
    expect(runHook('protect-merge.mjs', 'gh pr merge 5 --repo o/r', into('staging'))).toBe(2);
    expect(runHook('protect-merge.mjs', 'gh pr merge $PR --merge', into('staging'))).toBe(2);
  });

  it('blocks a REST or MCP merge into production however it is spelled', () => {
    for (const command of [
      'gh api -X PUT repos/o/r/pulls/12/merge',
      'gh api repos/{owner}/{repo}/pulls/12/merge --method PUT -f merge_method=merge',
      'gh api --method=PUT "repos/{owner}/{repo}/pulls/12/merge" -f merge_method=merge',
      'gh api -X PUT repos/{owner}/{repo}/pulls/12/ccr/auto_merge',
      'gh api repos/{owner}/{repo}/pulls/12/ccr/auto_merge -f merge_method=merge',
    ]) {
      expect(runHook('protect-merge.mjs', command, into('main', 12)), command).toBe(2);
      expect(runHook('protect-merge.mjs', command, into('staging', 12)), command).toBe(0);
    }
    expect(runHook('protect-merge.mjs', MCP, into('main', 12))).toBe(2);
    expect(runHook('protect-merge.mjs', MCP, into('staging', 12))).toBe(0);
    expect(runHook('protect-merge.mjs', MCP, 'exit 1')).toBe(2);
    const official = { ...MCP, tool_name: 'mcp__github-official__merge_pull_request' };
    expect(runHook('protect-merge.mjs', official, into('main', 12))).toBe(2);
    expect(runHook('protect-merge.mjs', official, into('staging', 12))).toBe(0);
    const unreadable = { ...MCP, tool_input: { pull_number: 12 } };
    expect(runHook('protect-merge.mjs', unreadable, into('staging', 12))).toBe(2);
  });

  it('refuses landing on production with no pull request, and allows a branch cleanup', () => {
    for (const command of DIRECT) {
      expect(runHook('protect-merge.mjs', command, 'exit 1'), command).toBe(2);
    }
    const cleanup = 'gh api -X DELETE "repos/{owner}/{repo}/git/refs/heads/$branch"';
    expect(runHook('protect-merge.mjs', cleanup, 'exit 1')).toBe(0);
    const intoStaging = 'gh api repos/o/r/merges -f base=staging -f head=x';
    expect(runHook('protect-merge.mjs', intoStaging, 'exit 1')).toBe(0);
  });
});

describe('require-canon on an MCP merge', () => {
  const files = (base, list) => pr(base, list, 12);

  it('refuses a governed change into integration with no canon update', () => {
    expect(runHook('require-canon.mjs', MCP, files('staging', ['src/lib/content.ts']))).toBe(2);
  });

  it('allows it once a canon file changed, or when nothing governed did', () => {
    const withCanon = ['src/lib/content.ts', 'docs/canon/architecture.md'];
    expect(runHook('require-canon.mjs', MCP, files('staging', withCanon))).toBe(0);
    expect(runHook('require-canon.mjs', MCP, files('staging', ['README.md']))).toBe(0);
  });

  it('asks nothing of a release into production, and fails open on an unreadable one', () => {
    expect(runHook('require-canon.mjs', MCP, files('main', ['src/lib/content.ts']))).toBe(0);
    expect(runHook('require-canon.mjs', MCP, 'exit 1')).toBe(0);
  });
});

describe('require-canon on a gh command', () => {
  const governed = pr('staging', ['src/lib/content.ts']);
  // A feature branch whose diff touches a governed path and no canon file.
  const feature = (branch = 'feature') =>
    `case "$*" in *rev-parse*) echo ${branch};; *diff*) echo src/lib/content.ts;; *) exit 0;; esac`;

  it('honours the bypass as an assignment on the gh command, not as text in its body', () => {
    const canon = (command) =>
      runHook('require-canon.mjs', command, governed, undefined, feature());
    expect(canon('gh pr create --fill')).toBe(2);
    expect(canon('ALLOW_UNDECIDED_MERGE=1 gh pr create --fill')).toBe(0);
    expect(canon('ALLOW_UNDECIDED_MERGE=1 gh pr merge 57')).toBe(0);
    expect(canon('gh pr create --fill --body "ALLOW_UNDECIDED_MERGE=1 gh pr create"')).toBe(2);
    expect(canon('gh pr merge 57 --body "ALLOW_UNDECIDED_MERGE=1 gh pr merge 57"')).toBe(2);
  });

  it('allows the release pull request however --base and --head are spelled', () => {
    for (const command of [
      'gh pr create -B main -H staging --fill',
      'gh pr create --base "main" --head "staging" --fill',
      'gh pr create --base=main --head=staging --fill',
    ]) {
      expect(runHook('require-canon.mjs', command, 'exit 1', undefined, feature()), command).toBe(
        0
      );
    }
  });

  it('judges a merge or ready that names a pull request on that pull request', () => {
    const check = (command, gh, branch = 'feature') =>
      runHook('require-canon.mjs', command, gh, undefined, feature(branch));
    const withCanon = pr('staging', ['src/lib/content.ts', 'docs/canon/architecture.md']);
    expect(check('gh pr merge 57 --merge', governed)).toBe(2);
    expect(check('gh pr ready 57', governed)).toBe(2);
    expect(check('gh pr merge 57 --merge', withCanon)).toBe(0);
    expect(check('gh pr merge 57 --merge', pr('main', ['src/lib/content.ts']))).toBe(0);
    expect(check('gh pr merge 57 --merge', 'exit 1')).toBe(0);
    // On the integration branch the checked-out diff says nothing about the pull request merged.
    expect(check('gh pr merge --merge', governed, 'staging')).toBe(2);
  });

  it('fails open on a merge aimed at another repository', () => {
    const migrations = pr('staging', ['supabase/migrations/0005_x.sql']);
    expect(runHook('require-canon.mjs', 'gh pr merge 5 --repo o/r', migrations)).toBe(0);
  });

  it('leaves a write with no pull request to protect-merge', () => {
    const migrations = pr('staging', ['supabase/migrations/0005_x.sql']);
    for (const command of DIRECT) {
      expect(runHook('require-canon.mjs', command, migrations), command).toBe(0);
    }
  });

  it('reads the map from the project, and refuses with a reason when it is missing', () => {
    const project = makeProject({ domains: { $comment: [], 'other.md': ['lib/'] } });
    const result = (gh) => run('require-canon.mjs', 'gh pr merge 57', gh, { project }).status;
    expect(result(pr('staging', ['src/lib/content.ts']))).toBe(0);
    expect(result(pr('staging', ['lib/x.ts']))).toBe(2);
    rmSync(join(project, '.claude/canon-domains.json'));
    const missing = run('require-canon.mjs', 'gh pr merge 57', governed, { project });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/canon-domains\.json is missing/);
    rmSync(project, { recursive: true, force: true });
  });
});

describe('protect-push', () => {
  let repo;
  const push = (command) =>
    run('protect-push.mjs', command, 'exit 1', { cwd: repo.dir, project: repo.dir }).status;

  beforeEach(() => {
    repo = scratchRepo();
  });
  afterEach(() => rmSync(repo.dir, { recursive: true, force: true }));

  it('refuses a force push and any push landing on a protected branch', () => {
    const allowed = [
      'git push origin HEAD:main',
      'git push origin feature:refs/heads/staging',
      'git push origin +x',
      'git push --force-with-lease',
      'git push origin --force',
      'git push --force-if-includes origin HEAD',
      'git push -uf origin HEAD',
      'git push origin :staging',
      'git push origin --delete main',
      'git push -d origin staging',
      'git push --all origin',
      'git push --mirror origin',
      'git push origin main',
      '/usr/bin/git push origin HEAD:main',
      'bash -c "git push origin HEAD:main"',
      'git -C . push origin HEAD:main',
      'git status && git push origin HEAD:staging',
      'out="$(git push origin HEAD:main)"',
      'timeout 60 git push origin HEAD:main',
      "git push origin 'refs/heads/*:refs/heads/*'",
      'git push --repo=origin main',
      'env --chdir /tmp git push origin HEAD:main',
      'cat <<< hello\ngit push origin HEAD:main',
      'sh -s <<EOF\ngit push origin HEAD:main\nEOF',
      'git commit -m "$(cat <<\'EOF\'\nfix: read the :-( case\nEOF\n)" && git push origin HEAD:main',
      "echo 'git push origin HEAD:main' | bash",
      'git push origin :',
      'git push origin +:',
      'git push origin heads/main',
      'git push origin HEAD:heads/staging',
      'git -c push.default=matching push origin',
      'git -c remote.origin.push=HEAD:main push',
      'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=push.default GIT_CONFIG_VALUE_0=matching git push',
      'echo HEAD:main | xargs git push origin',
      'echo $(( $(git push origin HEAD:main) + 0 ))',
      'git push origin $BRANCH',
      'git push origin `cat b`',
    ].filter((command) => push(command) !== 2);
    expect(allowed).toEqual([]);
  }, 60_000);

  it('allows a feature branch push and prose about pushing', () => {
    const refused = [
      'git push -u origin HEAD',
      'git push',
      'git push origin feature',
      'git push origin --delete old-branch',
      'git push -o ci.skip origin HEAD',
      'git push --tags origin',
      'git commit -m "never git push --force to main"',
      'echo git push origin HEAD:main',
    ].filter((command) => push(command) !== 0);
    expect(refused).toEqual([]);
  }, 30_000);

  it('resolves HEAD and a bare push against the checked-out branch and its config', () => {
    repo.git('checkout', '-q', 'staging');
    const onStaging = [
      'git push origin HEAD',
      'git push -u origin HEAD',
      'git push origin refs/heads/main',
      'git push',
    ].filter((c) => push(c) !== 2);
    expect(onStaging).toEqual([]);

    // A feature branch tracking the integration branch.
    repo.git('checkout', '-q', 'feature');
    repo.git('config', 'branch.feature.merge', 'refs/heads/staging');
    expect(push('git push')).toBe(2);

    // `matching` pushes every branch the remote shares, whichever is checked out.
    repo.git('config', 'branch.feature.merge', 'refs/heads/feature');
    repo.git('config', 'push.default', 'matching');
    expect(push('git push')).toBe(2);
    repo.git('config', '--unset', 'push.default');

    // A configured push refspec replaces the branch and its upstream.
    repo.git('config', 'remote.origin.push', 'HEAD:refs/heads/main');
    expect(push('git push')).toBe(2);
  }, 30_000);

  it('reads the protected branches from canon.json', () => {
    const config = {
      ...CONFIG,
      branches: { ...CONFIG.branches, integration: 'dev', production: 'live' },
    };
    writeFileSync(join(repo.dir, '.claude/canon.json'), JSON.stringify(config));
    expect(push('git push origin HEAD:live')).toBe(2);
    expect(push('git push origin HEAD:dev')).toBe(2);
    expect(push('git push origin HEAD:main')).toBe(0);
    const { stderr } = run('protect-push.mjs', 'git push origin HEAD:live', 'exit 1', {
      cwd: repo.dir,
      project: repo.dir,
    });
    expect(stderr).toMatch(/`dev` and `live` take no direct push/);
  });

  it('honours each bypass for its own check only', () => {
    const env = (vars) =>
      run('protect-push.mjs', 'git push origin HEAD:main', 'exit 1', {
        cwd: repo.dir,
        project: repo.dir,
        env: vars,
      }).status;
    expect(env({ ALLOW_FORCE_PUSH: '1' })).toBe(2);
    expect(env({ ALLOW_PROTECTED_PUSH: '1' })).toBe(0);
    const force = run('protect-push.mjs', 'git push --force origin HEAD', 'exit 1', {
      cwd: repo.dir,
      project: repo.dir,
      env: { ALLOW_PROTECTED_PUSH: '1' },
    });
    expect(force.status).toBe(2);
  });

  it('fails open on an unreadable payload', () => {
    expect(runHook('protect-push.mjs', 'not json')).toBe(0);
  });
});

/**
 * Claude Code reads any exit but 2 as permission, so a guard that throws would let every call
 * through. Each case runs the real hook from a copy of the hooks directory with one helper module
 * replaced, and expects a refusal on a guarded call and a plain one alike, because a crashed
 * parser cannot say which one it is looking at.
 */
describe('a crashed guard refuses', () => {
  const MERGE_BROKEN = [
    [
      'throws',
      "export const mergesIn = () => { throw new Error('broken') }\n" +
        "export const prCalls = () => { throw new Error('broken') }\n" +
        'export const prDetails = () => ({ ok: false })\nexport const prFiles = () => ({ ok: false })\n',
    ],
    ['fails to link', 'export {}\n'],
    ['has a syntax error', 'export const mergesIn = (\n'],
  ];

  for (const hook of ['protect-merge.mjs', 'require-canon.mjs']) {
    it.each(MERGE_BROKEN)(`${hook} refuses every call when merge-command.mjs %s`, (_, source) => {
      const dir = brokenHooks('merge-command.mjs', source);
      for (const command of [MERGE, 'ls']) {
        const result = run(hook, command, pr('staging', ['src/x.ts']), { hooksDir: dir });
        expect(result.status, command).toBe(2);
        expect(result.stderr).toMatch(/crashed/);
      }
      rmSync(dir, { recursive: true, force: true });
    });
  }

  it.each([
    [
      'throws',
      "export const pushTargets = () => { throw new Error('broken') }\nexport const readRefspec = () => ({})\n",
    ],
    ['fails to link', 'export {}\n'],
    ['has a syntax error', 'export const pushTargets = (\n'],
  ])('protect-push refuses every call when push-command.mjs %s', (_, source) => {
    const dir = brokenHooks('push-command.mjs', source);
    for (const command of ['git push origin HEAD:main', 'ls']) {
      const result = run('protect-push.mjs', command, 'exit 1', { hooksDir: dir });
      expect(result.status, command).toBe(2);
      expect(result.stderr).toMatch(/crashed/);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('require-canon still honours ALLOW_UNDECIDED_MERGE from the session when it would crash', () => {
    const dir = brokenHooks('merge-command.mjs', 'export {}\n');
    const result = run('require-canon.mjs', MERGE, 'exit 1', {
      hooksDir: dir,
      env: { ALLOW_UNDECIDED_MERGE: '1' },
    });
    expect(result.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('require-canon refuses a governed merge when canon-domains.json is malformed', () => {
    const project = makeProject({ domains: '{ not json' });
    const result = run('require-canon.mjs', MERGE, pr('staging', ['src/x.ts']), { project });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/crashed/);
    rmSync(project, { recursive: true, force: true });
  });
});

/**
 * The plugin may be installed at user scope, so its hooks run in every repository. A repository
 * that never adopted canon is left alone; one that adopted it and lost its config is refused on
 * the guarded calls, with the way out.
 */
describe('the project config', () => {
  it('leaves a repository with no canon.json and no docs/canon alone', () => {
    const project = makeProject({ config: false, domains: false, canonDir: false });
    for (const [hook, command] of [
      ['protect-push.mjs', 'git push origin HEAD:main'],
      ['protect-merge.mjs', MERGE],
      ['require-canon.mjs', 'gh pr create --fill'],
      ['protect-branch.mjs', 'echo x > src/a.ts'],
    ]) {
      const result = run(hook, command, into('main'), { project });
      expect(result.status, hook).toBe(0);
      expect(result.stderr, hook).toBe('');
    }
    expect(run('branch-notice.mjs', {}, 'exit 1', { project }).stdout).toBe('');
    rmSync(project, { recursive: true, force: true });
  });

  it('refuses the guarded calls when docs/canon exists and canon.json does not', () => {
    const project = makeProject({ config: false });
    for (const [hook, command] of [
      ['protect-push.mjs', 'git push origin HEAD:feature'],
      ['protect-merge.mjs', MERGE],
      ['require-canon.mjs', 'gh pr create --fill'],
    ]) {
      const result = run(hook, command, into('staging'), { project });
      expect(result.status, hook).toBe(2);
      expect(result.stderr, hook).toMatch(/\/canon:setup/);
    }
    // Everything else passes, including the writes /canon:setup itself has to make.
    expect(run('protect-push.mjs', 'git status', 'exit 1', { project }).status).toBe(0);
    expect(run('protect-merge.mjs', 'gh pr view 5', 'exit 1', { project }).status).toBe(0);
    expect(run('protect-branch.mjs', 'echo x > src/a.ts', 'exit 1', { project }).status).toBe(0);
    expect(run('branch-notice.mjs', {}, 'exit 1', { project }).stdout).toMatch(/\/canon:setup/);
    rmSync(project, { recursive: true, force: true });
  });

  it('names every problem in an invalid canon.json', () => {
    const project = makeProject({
      config: { ...CONFIG, owner: '', branches: { ...CONFIG.branches, production: 'staging' } },
    });
    const { status, stderr } = run('protect-merge.mjs', MERGE, into('staging'), { project });
    expect(status).toBe(2);
    expect(stderr).toMatch(/`owner`/);
    expect(stderr).toMatch(/must differ/);
    rmSync(project, { recursive: true, force: true });
  });

  it('refuses on a canon.json that is not JSON', () => {
    const project = makeProject({ config: '{ nope' });
    const { status, stderr } = run('protect-merge.mjs', MERGE, into('staging'), { project });
    expect(status).toBe(2);
    expect(stderr).toMatch(/not valid JSON/);
    rmSync(project, { recursive: true, force: true });
  });
});

describe('protect-branch and branch-notice', () => {
  let repo;
  const edit = (file, extra = {}) =>
    run(
      'protect-branch.mjs',
      { tool_name: 'Write', tool_input: { file_path: file }, cwd: repo.dir },
      'exit 1',
      { project: repo.dir, ...extra }
    );

  beforeEach(() => {
    repo = scratchRepo();
  });
  afterEach(() => rmSync(repo.dir, { recursive: true, force: true }));

  it('allows an edit on a feature branch and refuses one on a protected branch', () => {
    expect(edit(join(repo.dir, 'src/a.ts')).status).toBe(0);
    repo.git('checkout', '-q', 'staging');
    const refused = edit(join(repo.dir, 'src/a.ts'));
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/`feat\/`, `fix\/`/);
    repo.git('checkout', '-q', 'main');
    expect(edit('src/a.ts').status).toBe(2);
  });

  it('allows an edit outside the project, and honours the bypass', () => {
    repo.git('checkout', '-q', 'main');
    expect(edit(join(tmpdir(), 'scratch.txt')).status).toBe(0);
    expect(edit('src/a.ts', { env: { ALLOW_PROTECTED_BRANCH_EDIT: '1' } }).status).toBe(0);
  });

  it('refuses a Bash command that writes on a protected branch, and allows a read', () => {
    repo.git('checkout', '-q', 'main');
    const bash = (command) =>
      run('protect-branch.mjs', command, 'exit 1', { cwd: repo.dir, project: repo.dir }).status;
    expect(bash("sed -i '' s/a/b/ README.md")).toBe(2);
    expect(bash('git status')).toBe(0);
  });

  it('says a protected branch is checked out, and nothing on a feature branch', () => {
    const notice = () =>
      run('branch-notice.mjs', { cwd: repo.dir }, 'exit 1', { project: repo.dir });
    expect(notice().stdout).toBe('');
    repo.git('checkout', '-q', 'staging');
    const { status, stdout } = notice();
    expect(status).toBe(0);
    expect(stdout).toMatch(/`staging` is checked out/);
  });
});

/**
 * The formatter runs a command named in the repository's own files, so it runs only when the
 * project's committed settings enable the plugin, and never through a shell.
 */
describe('format-file', () => {
  let project;
  let log;

  beforeEach(() => {
    project = makeProject();
    log = join(project, 'argv.json');
    const formatter = join(project, 'fake-format.mjs');
    writeFileSync(
      formatter,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\n`
    );
    writeFileSync(
      join(project, '.claude/canon.json'),
      JSON.stringify({ ...CONFIG, formatFile: [process.execPath, formatter, '--write'] })
    );
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  const write = (file) =>
    run(
      'format-file.mjs',
      { tool_name: 'Write', tool_input: { file_path: file }, cwd: project },
      'exit 1',
      {
        project,
      }
    );
  const enable = (value) =>
    writeFileSync(
      join(project, '.claude/settings.json'),
      JSON.stringify({ enabledPlugins: { 'canon@arhaty': value } })
    );

  it('does nothing unless the project settings enable the plugin', () => {
    const file = join(project, 'a.ts');
    writeFileSync(file, 'x');
    expect(write(file).status).toBe(0);
    expect(existsSync(log)).toBe(false);
    enable(false);
    write(file);
    expect(existsSync(log)).toBe(false);
  });

  it('passes the path as one argument, with no shell in between', () => {
    enable(true);
    mkdirSync(join(project, 'odd dir'));
    const file = join(project, 'odd dir', 'a $(touch pwned) b.ts');
    writeFileSync(file, 'x');
    expect(write(file).status).toBe(0);
    expect(JSON.parse(readFileSync(log, 'utf8'))).toEqual(['--write', realpathSync(file)]);
    expect(existsSync(join(project, 'pwned'))).toBe(false);
  });

  it('never runs without a path, or on a path outside the project', () => {
    enable(true);
    run('format-file.mjs', { tool_name: 'Write', tool_input: {}, cwd: project }, 'exit 1', {
      project,
    });
    expect(existsSync(log)).toBe(false);
    const outside = join(tmpdir(), `canon-outside-${process.pid}.ts`);
    writeFileSync(outside, 'x');
    write(outside);
    rmSync(outside);
    expect(existsSync(log)).toBe(false);
  });
});

describe('hooks.json', () => {
  const config = JSON.parse(readFileSync(join(HOOKS, 'hooks.json'), 'utf8'));

  it('runs the merge hooks on any MCP server merge tool', () => {
    const guarded = config.hooks.PreToolUse.filter((entry) =>
      entry.hooks.some((hook) => hook.command?.includes('/protect-merge.mjs'))
    ).map((entry) => new RegExp(`^(?:${entry.matcher})$`));
    const runs = (tool) => guarded.some((matcher) => matcher.test(tool));
    expect(runs('mcp__github__merge_pull_request')).toBe(true);
    expect(runs('mcp__github-official__merge_pull_request')).toBe(true);
    expect(runs('mcp__claude_ai_GitHub__merge_pull_request')).toBe(true);
    expect(runs('mcp__github__get_pull_request')).toBe(false);
  });

  it('points every command at a file that exists, through CLAUDE_PLUGIN_ROOT', () => {
    const commands = Object.values(config.hooks)
      .flat()
      .flatMap((entry) => entry.hooks.map((hook) => hook.command));
    for (const command of commands) {
      const [, path] = /"\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"/.exec(command) ?? [];
      expect(path === undefined ? command : 'ok', command).toBe('ok');
      expect(existsSync(join(ROOT, path)), path).toBe(true);
    }
  });
});

describe('ci-watch.sh', () => {
  it('stays silent on a command that starts no CI run', () => {
    const result = spawnSync('bash', [join(HOOKS, 'ci-watch.sh')], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' } }),
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});
