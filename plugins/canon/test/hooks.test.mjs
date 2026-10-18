/**
 * The hooks run end to end, as Claude Code runs them: a JSON payload on stdin, a stub
 * `gh` (and sometimes `git`) on PATH, and a scratch project with its own
 * `.claude/canon.json`. Exit 0 allows the call, exit 2 refuses it.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { textTargets, watchTargets } from '../hooks/lib/ci-triggers.mjs';
import { commandDigest, trustKey } from '../hooks/lib/config.mjs';
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

  it('reads a merge with no number from the worktree it runs in', () => {
    const repo = scratchRepo();
    const tree = join(repo.dir, '.wt');
    try {
      repo.git('worktree', 'add', '-q', '-b', 'feat/x', tree, 'staging');
      // The stub answers for the pull request of whichever checkout gh runs in.
      const gh =
        'case "$(pwd)" in *.wt*) echo \'{"baseRefName":"staging","number":7}\';; ' +
        '*) echo \'{"baseRefName":"main","number":8}\';; esac';
      const merge = (cwd) =>
        run('protect-merge.mjs', 'gh pr merge --merge', gh, { cwd, project: repo.dir }).status;
      expect(merge(tree)).toBe(0);
      expect(merge(repo.dir)).toBe(2);
    } finally {
      repo.git('worktree', 'remove', '--force', tree);
      rmSync(repo.dir, { recursive: true, force: true });
    }
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

  it('refuses a contents, ref or protection write to production, and any write naming it', () => {
    for (const command of [
      'gh api -X PUT repos/{owner}/{repo}/contents/a.md -f message=x -f content=eA== -f branch=main',
      'gh api -X PUT repos/o/r/contents/a.md -f message=x -f content=eA==',
      'gh api repos/o/r/git/refs -f ref=refs/heads/main -f sha=abc',
      'gh api -X DELETE repos/o/r/branches/main/protection',
      'gh api -X PATCH repos/o/r/pulls/5 -f base=main',
    ]) {
      expect(runHook('protect-merge.mjs', command, 'exit 1'), command).toBe(2);
    }
    for (const command of [
      'gh api -X PUT repos/o/r/contents/a.md -f message=x -f content=eA== -f branch=feat/x',
      'gh api repos/o/r/git/refs -f ref=refs/heads/feat/x -f sha=abc',
      'gh api repos/o/r/issues/5/comments -f body=hello',
    ]) {
      expect(runHook('protect-merge.mjs', command, 'exit 1'), command).toBe(0);
    }
  });

  it('allows the release pull request and reads that change nothing', () => {
    // `/canon:production` opens the release pull request, which is not a merge.
    for (const command of [
      'gh pr create --base main --head staging --title "release" --body "x"',
      'gh pr create -B main -H staging --fill',
      'gh api repos/o/r/pulls',
      'gh api graphql -f query=query{viewer{login}}',
      'gh api graphql -f query=\'query($n: Int!) { repository(owner: "o", name: "r") { pullRequest(number: $n) { baseRefName } } }\' -F n=5',
    ]) {
      expect(runHook('protect-merge.mjs', command, 'exit 1'), command).toBe(0);
    }
  });

  it('refuses a GraphQL mutation that moves a branch, or one it cannot read', () => {
    for (const command of [
      'gh api graphql -f query="mutation { mergeBranch(input: {}) { clientMutationId } }"',
      'gh api graphql -f query="mutation { updateRef(input: {}) { clientMutationId } }"',
      'gh api graphql -f query="mutation { createCommitOnBranch(input: {}) { commit { oid } } }"',
      'gh api graphql -f query="mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }"',
      'gh api graphql -f query="mutation { mergePullRequest(input: {}) { clientMutationId } }"',
      'gh api graphql -F query=@mutation.graphql',
      'gh api graphql --input body.json',
      // Unparsable: unbalanced, and not GraphQL at all.
      'gh api graphql -f query="mutation { mergeBranch(input: {}) { clientMutationId }"',
      'gh api graphql -f query="this is not graphql"',
      `gh api graphql -f query='mutation { addComment(input: {subjectId: "X", body: "main"}) { clientMutationId } }'`,
    ]) {
      expect(runHook('protect-merge.mjs', command, 'exit 1'), command).toBe(2);
    }
    for (const command of [
      'gh api graphql -f query="{ viewer { login } }"',
      `gh api graphql -f query='mutation { addComment(input: {subjectId: "X", body: "hi"}) { clientMutationId } }'`,
    ]) {
      expect(runHook('protect-merge.mjs', command, 'exit 1'), command).toBe(0);
    }
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

  it('judges every call in one command inside the hook timeout when the fetch hangs', () => {
    // Clean against the integration branch, governed against `dev`, so the calls before
    // the last one pass and each would fetch again.
    const hung =
      'case "$*" in *fetch*) exec sleep 30;; *rev-parse*) echo feature;; ' +
      '*origin/dev...*) echo src/lib/content.ts;; *) exit 0;; esac';
    const started = Date.now();
    const status = runHook(
      'require-canon.mjs',
      'gh pr create --fill && gh pr ready && gh pr create -B dev --fill',
      'exit 1',
      undefined,
      hung
    );
    expect(status).toBe(2);
    // One fetch per base, all inside the shared 15-second deadline. The hook gets 20;
    // past that, Claude Code lets the call through.
    expect(Date.now() - started).toBeLessThan(17_000);
  }, 60_000);

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

  it('judges a worktree by its own branch, and leaves another repository alone', () => {
    const c = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
    /** A scratch repository with `origin` pointing at itself, so `origin/staging` exists. */
    const withOrigin = () => {
      const repo = scratchRepo();
      repo.git('remote', 'add', 'origin', repo.dir);
      repo.git('fetch', '-q', 'origin');
      return repo;
    };
    /** Commit a governed path on the branch checked out in `dir`. */
    const governedCommit = (dir) => {
      mkdirSync(join(dir, 'src/lib'), { recursive: true });
      writeFileSync(join(dir, 'src/lib/content.ts'), 'x\n');
      spawnSync('git', ['-C', dir, 'add', 'src/lib/content.ts']);
      const done = spawnSync('git', ['-C', dir, ...c, 'commit', '-q', '-m', 'x'], {
        encoding: 'utf8',
      });
      expect(done.status, done.stderr).toBe(0);
    };

    const repo = withOrigin();
    const other = withOrigin();
    const tree = join(repo.dir, '.wt');
    try {
      repo.git('checkout', '-q', 'staging');
      repo.git('worktree', 'add', '-q', '-b', 'feat/x', tree, 'staging');
      governedCommit(tree);
      governedCommit(other.dir);

      const create = (cwd, project = repo.dir) =>
        run('require-canon.mjs', 'gh pr create --fill', 'exit 1', { cwd, project }).status;
      // The worktree's feature branch carries a governed change; the main checkout is on
      // the integration branch, which is not judged.
      expect(create(tree)).toBe(2);
      expect(create(repo.dir)).toBe(0);
      // The same change in another repository is refused there, and not from this project.
      expect(create(other.dir, other.dir)).toBe(2);
      expect(create(other.dir)).toBe(0);

      // After a cd in the same command, nothing says which checkout `gh` acts on: refused,
      // even from the integration branch, which is never judged by diff.
      const after = (command, cwd = repo.dir) =>
        run('require-canon.mjs', command, 'exit 1', { cwd, project: repo.dir });
      for (const command of [
        `cd ${tree} && gh pr create --fill`,
        `cd ${other.dir} && gh pr create --fill`,
        `(cd ${other.dir}) && gh pr create --fill`,
        `bash -c "cd ${other.dir}" && gh pr create --fill`,
        `cd ${other.dir} || gh pr create --fill`,
        `false &&\ncd ${other.dir}\ngh pr create --fill`,
        `(case a in a) ;; esac; cd ${other.dir}); gh pr create --fill`,
      ]) {
        const result = after(command);
        expect(result.status, command).toBe(2);
        expect(result.stderr, command).toMatch(/follows a `cd` in the same command/);
      }
      expect(after(`cd ${tree} && ALLOW_UNDECIDED_MERGE=1 gh pr create --fill`).status).toBe(0);
      // A `cd` after the call does not touch it.
      expect(after(`gh pr create --fill; cd ${other.dir}`, tree).status).toBe(2);
      expect(after(`gh pr view; cd ${other.dir}`, tree).status).toBe(0);
    } finally {
      repo.git('worktree', 'remove', '--force', tree);
      rmSync(repo.dir, { recursive: true, force: true });
      rmSync(other.dir, { recursive: true, force: true });
    }
  });

  it('counts a file renamed out of a governed path under its old path', () => {
    const repo = scratchRepo();
    const c = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
    try {
      repo.git('checkout', '-q', 'staging');
      mkdirSync(join(repo.dir, 'src/lib'), { recursive: true });
      writeFileSync(join(repo.dir, 'src/lib/content.ts'), 'export const a = 1;\n'.repeat(20));
      repo.git('add', 'src/lib/content.ts');
      repo.git(...c, 'commit', '-q', '-m', 'governed');
      repo.git('remote', 'add', 'origin', repo.dir);
      repo.git('fetch', '-q', 'origin');
      repo.git('checkout', '-q', '-b', 'feat/move', 'origin/staging');
      mkdirSync(join(repo.dir, 'elsewhere'));
      repo.git('mv', 'src/lib/content.ts', 'elsewhere/content.ts');
      repo.git(...c, 'commit', '-q', '-m', 'move');
      const { status } = run('require-canon.mjs', 'gh pr create --fill', 'exit 1', {
        cwd: repo.dir,
        project: repo.dir,
      });
      expect(status).toBe(2);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
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

  it('refuses a push of HEAD when HEAD names no branch', () => {
    repo.git('checkout', '-q', '--detach');
    expect(push('git push origin HEAD')).toBe(2);
    expect(push('git push')).toBe(2);
    // A named branch needs no read of HEAD, detached or not.
    expect(push('git push origin feature')).toBe(0);
  });

  it('refuses a push that reads HEAD after a cd, unless -C names the checkout', () => {
    const tree = join(repo.dir, '.wt');
    repo.git('worktree', 'add', '-q', tree, 'staging');
    try {
      for (const command of [
        `cd ${tree} && git push origin HEAD`,
        'cd .wt && git push',
        `(cd ${tree}) && git push origin HEAD`,
        `{ cd ${tree}; git push; }`,
        `if cd ${tree}; then git push; fi`,
        `case a in a) cd ${tree};; esac; git push`,
        `false &&\ncd ${tree}\ngit push origin HEAD`,
      ]) {
        expect(push(command), command).toBe(2);
      }
      // A named branch needs no checkout's HEAD.
      expect(push(`cd ${tree} && git push origin feature`)).toBe(0);
      // An absolute -C names the checkout outright: staging's HEAD is refused, the
      // session's own feature branch is not.
      expect(push(`cd /tmp; git -C ${tree} push origin HEAD`)).toBe(2);
      expect(push(`cd /tmp; git -C ${repo.dir} push origin HEAD`)).toBe(0);
    } finally {
      repo.git('worktree', 'remove', '--force', tree);
    }
  });

  it('refuses inside the hook timeout when git hangs', () => {
    const started = Date.now();
    const { status, stderr } = run('protect-push.mjs', 'git push -u origin HEAD', 'exit 1', {
      cwd: repo.dir,
      project: repo.dir,
      git: 'exec sleep 30',
    });
    expect(status).toBe(2);
    expect(stderr).toMatch(/did not answer in time/);
    // The hook's own timeout is 15 seconds; past it, Claude Code lets the push through.
    expect(Date.now() - started).toBeLessThan(14_000);
  }, 30_000);

  it('refuses a brace expansion, which bash turns into a push to main', () => {
    expect(push('git push origin {main,feature}')).toBe(2);
    expect(push('git push origin HEAD:{main,x}')).toBe(2);
    expect(push('git push -u origin HEAD')).toBe(0);
    expect(push('git push origin HEAD@{0}:feat/x')).toBe(0);
    expect(push('git push origin HEAD@{0}:main')).toBe(2);
  });

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

  it("judges a write in a worktree by the worktree's branch, not the main checkout's", () => {
    const tree = join(repo.dir, '.wt');
    repo.git('checkout', '-q', 'staging');
    repo.git('worktree', 'add', '-q', '-b', 'feat/x', tree, 'staging');
    try {
      const write = (file, cwd) =>
        run(
          'protect-branch.mjs',
          { tool_name: 'Write', tool_input: { file_path: file }, cwd },
          'exit 1',
          { project: repo.dir }
        ).status;
      const bash = (cwd) =>
        run('protect-branch.mjs', "sed -i '' s/a/b/ README.md", 'exit 1', {
          cwd,
          project: repo.dir,
        }).status;
      // Main checkout on the integration branch, worktree under it on a feature branch.
      expect(write(join(tree, 'src/a.ts'), tree)).toBe(0);
      expect(write(join(tree, 'src/a.ts'), repo.dir)).toBe(0);
      expect(bash(tree)).toBe(0);
      expect(write(join(repo.dir, 'src/a.ts'), tree)).toBe(2);
      expect(bash(repo.dir)).toBe(2);
      // And the other way round.
      repo.git('checkout', '-q', 'feature');
      spawnSync('git', ['-C', tree, 'checkout', '-q', 'main']);
      expect(write(join(tree, 'src/a.ts'), tree)).toBe(2);
      expect(bash(tree)).toBe(2);
      expect(write(join(repo.dir, 'src/a.ts'), repo.dir)).toBe(0);
    } finally {
      repo.git('worktree', 'remove', '--force', tree);
    }
  });

  it('judges a Bash write where it runs, after cd and git -C', () => {
    repo.git('checkout', '-q', 'main');
    const scratch = mkdtempSync(join(tmpdir(), 'canon-elsewhere-'));
    const bash = (command, cwd) =>
      run('protect-branch.mjs', command, 'exit 1', { cwd, project: repo.dir }).status;
    try {
      // Into the project from elsewhere is a project write.
      expect(bash(`cd ${repo.dir} && sed -i '' s/a/b/ README.md`, scratch)).toBe(2);
      expect(bash(`git -C ${repo.dir} commit -m x`, scratch)).toBe(2);
      // Out of the project to write elsewhere is not.
      expect(bash(`cd ${scratch} && sed -i '' s/a/b/ notes.md`, repo.dir)).toBe(0);
      expect(bash(`git -C ${scratch} commit -m x`, repo.dir)).toBe(0);
      // A read in the project beside a write elsewhere is not a project write either.
      expect(bash(`git status && cd ${scratch} && touch a`, repo.dir)).toBe(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
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
 * owner approved that exact command for that project, in a file outside it, and never through a
 * shell.
 */
describe('format-file', () => {
  let project;
  let home;
  let log;
  let argv;

  beforeEach(() => {
    project = makeProject();
    home = mkdtempSync(join(tmpdir(), 'canon-home-'));
    log = join(project, 'argv.json');
    const formatter = join(project, 'fake-format.mjs');
    writeFileSync(
      formatter,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\n`
    );
    argv = [process.execPath, formatter, '--write'];
    writeFileSync(
      join(project, '.claude/canon.json'),
      JSON.stringify({ ...CONFIG, formatFile: argv })
    );
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const write = (file, tool = 'Write') =>
    run(
      'format-file.mjs',
      {
        tool_name: tool,
        tool_input: tool === 'NotebookEdit' ? { notebook_path: file } : { file_path: file },
        cwd: project,
      },
      'exit 1',
      { project, home }
    );
  /** What `scaffold.mjs trust` writes, for `command` in this project. */
  const approve = (command = argv) => {
    mkdirSync(join(home, '.claude/canon'), { recursive: true });
    writeFileSync(
      join(home, '.claude/canon/trusted.json'),
      JSON.stringify({
        [trustKey(project)]: { sha256: commandDigest(command), formatFile: command },
      })
    );
  };

  it('does nothing until the owner approves the command outside the repository', () => {
    const file = join(project, 'a.ts');
    writeFileSync(file, 'x');
    // The old gate: the repository enabling the plugin in its own settings proves nothing.
    writeFileSync(
      join(project, '.claude/settings.json'),
      JSON.stringify({ enabledPlugins: { 'canon@arhaty': true } })
    );
    expect(write(file).status).toBe(0);
    expect(existsSync(log)).toBe(false);
    approve();
    write(file);
    expect(existsSync(log)).toBe(true);
  });

  it('stays off once the command changes', () => {
    const file = join(project, 'a.ts');
    writeFileSync(file, 'x');
    approve();
    writeFileSync(
      join(project, '.claude/canon.json'),
      JSON.stringify({ ...CONFIG, formatFile: [...argv, '--extra'] })
    );
    write(file);
    expect(existsSync(log)).toBe(false);
  });

  it('runs on a notebook edit too', () => {
    approve();
    const file = join(project, 'a.ipynb');
    writeFileSync(file, '{}');
    write(file, 'NotebookEdit');
    expect(JSON.parse(readFileSync(log, 'utf8'))).toEqual(['--write', realpathSync(file)]);
  });

  it('passes the path as one argument, with no shell in between', () => {
    approve();
    mkdirSync(join(project, 'odd dir'));
    const file = join(project, 'odd dir', 'a $(touch pwned) b.ts');
    writeFileSync(file, 'x');
    expect(write(file).status).toBe(0);
    expect(JSON.parse(readFileSync(log, 'utf8'))).toEqual(['--write', realpathSync(file)]);
    expect(existsSync(join(project, 'pwned'))).toBe(false);
  });

  it('never runs without a path, or on a path outside the project', () => {
    approve();
    run('format-file.mjs', { tool_name: 'Write', tool_input: {}, cwd: project }, 'exit 1', {
      project,
      home,
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

  it('formats after every file tool, notebooks included', () => {
    const [formatter] = config.hooks.PostToolUse.filter((entry) =>
      entry.hooks.some((hook) => hook.command?.includes('/format-file.mjs'))
    );
    expect(formatter.matcher.split('|').sort()).toEqual(['Edit', 'NotebookEdit', 'Write']);
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
  let repo;
  let bin;
  let log;

  beforeEach(() => {
    repo = scratchRepo();
    bin = mkdtempSync(join(tmpdir(), 'canon-bin-'));
    log = join(bin, 'gh.log');
  });
  afterEach(() => {
    rmSync(repo.dir, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });

  /**
   * Run the hook with a stub `gh` that logs every call and lists `runs` for any
   * commit, each with its conclusion; `conclusion` alone is one run, 42. `sleep` is
   * stubbed too, so the waits cost nothing. `project` is `$CLAUDE_PROJECT_DIR`, which
   * the payload's `cwd` overrides. `prHead` is what `gh pr view` prints: `<sha> <branch>`;
   * `ownRepo` what `gh repo view` does; `script` is the hook's path, which a test runs through
   * a symlink. A call made with `GH_REPO` set is logged as `[<repo>] <args>`. A run whose
   * conclusion is `hang` never finishes, one that is `stall` fails and never prints its log, and
   * with no runs at all the listing itself never answers. `env` adds to the hook's environment.
   */
  function watch({
    command,
    output = '',
    cwd = repo.dir,
    project = repo.dir,
    conclusion,
    runs = { 42: conclusion },
    prHead = '',
    ownRepo = '',
    script = join(HOOKS, 'ci-watch.sh'),
    env = {},
  }) {
    const of = Object.entries(runs)
      .map(([id, result]) => `${id}) echo ${result} ;;`)
      .join(' ');
    writeFileSync(
      join(bin, 'gh'),
      [
        '#!/bin/sh',
        `echo "\${GH_REPO:+[$GH_REPO] }$*" >> '${log}'`,
        `result() { case "$1" in ${of} esac; }`,
        'case "$1 $2" in',
        Object.keys(runs).length > 0
          ? `  "run list") printf '%s\\n' ${Object.keys(runs).join(' ')} ;;`
          : '  "run list") exec /bin/sleep 60 ;;',
        `  "pr view") echo '${prHead}' ;;`,
        `  "repo view") echo '${ownRepo}' ;;`,
        '  "run watch") r=$(result "$3"); [ "$r" = hang ] && exec /bin/sleep 60; [ "$r" = success ] ;;',
        '  "run view") case "$*" in *--log-failed*) [ "$(result "$3")" = stall ] && exec /bin/sleep 60; echo log ;; *) result "$3" ;; esac ;;',
        'esac',
      ].join('\n'),
      { mode: 0o755 }
    );
    writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const result = spawnSync('bash', [script], {
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command },
        tool_response: { stdout: '', stderr: output },
        cwd,
      }),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        CLAUDE_PROJECT_DIR: project,
        ...env,
      },
      timeout: 30000,
    });
    const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
    rmSync(log, { force: true });
    return { status: result.status, stderr: result.stderr, calls };
  }

  const sha = (ref) =>
    spawnSync('git', ['-C', repo.dir, 'rev-parse', ref], { encoding: 'utf8' }).stdout.trim();

  it('stays silent on a command that starts no CI run', () => {
    const result = spawnSync('bash', [join(HOOKS, 'ci-watch.sh')], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' } }),
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('reports a failed run, and only a failure', () => {
    const push = { command: 'git push -u origin HEAD' };
    expect(watch({ ...push, conclusion: 'failure' }).status).toBe(2);
    expect(watch({ ...push, conclusion: 'timed_out' }).status).toBe(2);
    expect(watch({ ...push, conclusion: 'success' }).status).toBe(0);
    expect(watch({ ...push, conclusion: 'cancelled' }).status).toBe(0);
    // A workflow that skipped itself is not a failure. Staging's own test pins that it
    // is not a pass either.
    expect(watch({ ...push, conclusion: 'skipped' }).status).toBe(0);
  });

  it('watches every run the push started, not only the newest', () => {
    const push = { command: 'git push -u origin HEAD' };
    // A deploy check that skips itself is listed first; the real run fails after it.
    const both = watch({ ...push, runs: { 41: 'skipped', 42: 'failure' } });
    expect(both.status).toBe(2);
    expect(both.calls).toContain('run watch 41');
    expect(both.calls).toContain('run watch 42');
    expect(both.calls).toContain('actions/runs/42/jobs');
    expect(both.calls).not.toContain('actions/runs/41/jobs');
    expect(watch({ ...push, runs: { 41: 'skipped', 42: 'success' } }).status).toBe(0);
    expect(watch({ ...push, runs: { 41: 'neutral', 42: 'cancelled' } }).status).toBe(0);
  });

  it('names the branch the push wrote, not the one checked out', () => {
    repo.git(
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'y'
    );
    const sent = sha('HEAD~1');
    const ranged = watch({
      command: 'git push origin other',
      output: `To origin\n   0000000..${sent.slice(0, 7)}  other -> other\nnext line\n`,
      conclusion: 'failure',
    });
    expect(ranged.stderr).toContain(`CI failed on other at ${sent}.`);
    const created = watch({
      command: 'git push -u origin HEAD:feat/new',
      output: " * [new branch]      HEAD -> feat/new\nbranch 'feature' set up\n",
      conclusion: 'failure',
    });
    expect(created.stderr).toContain('CI failed on feat/new at');
    // With nothing in the output to read, the checked-out branch.
    expect(watch({ command: 'git push', conclusion: 'failure' }).stderr).toContain(
      'CI failed on feature at'
    );
  });

  it('watches the commit the push sent, not HEAD', () => {
    repo.git(
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'y'
    );
    const sent = sha('HEAD~1');
    const { calls } = watch({
      command: 'git push origin older:feature',
      output: `To origin\n   0000000..${sent.slice(0, 7)}  older -> feature\n`,
      conclusion: 'success',
    });
    expect(calls).toContain(`--commit ${sent}`);
  });

  it('reads the commit, the source and the branch from the same ref line', () => {
    repo.git(
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'y'
    );
    repo.git('branch', 'other', 'HEAD~1');
    const older = sha('HEAD~1');
    // A new branch prints no range: its source ref names the commit, not HEAD.
    const created = watch({
      command: 'git push -u origin other',
      output: ' * [new branch]      other -> other\n',
      conclusion: 'failure',
    });
    expect(created.calls).toContain(`--commit ${older}`);
    expect(created.stderr).toContain(`CI failed on other at ${older}.`);
    // Two refs: the last line wins whole, never a commit from one and a branch from another.
    const both = watch({
      command: 'git push origin feature other',
      output: `   0000000..${sha('HEAD').slice(0, 7)}  feature -> feature\n * [new branch]      other -> other\n`,
      conclusion: 'failure',
    });
    expect(both.stderr).toContain(`CI failed on other at ${older}.`);
  });

  it('stays quiet about a commit this checkout cannot resolve', () => {
    const result = watch({
      command: 'cd ../elsewhere && git push',
      output: '   0000000..abcdef1  main -> main\n',
      conclusion: 'failure',
    });
    expect(result.status).toBe(0);
    expect(result.calls).toBe('');
  });

  it('runs in a worktree whose checkout predates the config, and nowhere else', () => {
    const tree = join(repo.dir, '.wt');
    repo.git('worktree', 'add', '-q', '--detach', tree, 'HEAD');
    const unrelated = scratchRepo();
    try {
      // The worktree's checkout has no config; the project's does.
      rmSync(join(tree, '.claude/canon.json'), { force: true });
      const inTree = watch({
        command: 'git push origin HEAD:feat/x',
        cwd: tree,
        conclusion: 'failure',
      });
      expect(inTree.status).toBe(2);
      // Another repository with no config is not this project's CI.
      rmSync(join(unrelated.dir, '.claude/canon.json'));
      const elsewhere = watch({
        command: 'git push -u origin HEAD',
        cwd: unrelated.dir,
        conclusion: 'failure',
      });
      expect(elsewhere.status).toBe(0);
      expect(elsewhere.calls).toBe('');
    } finally {
      repo.git('worktree', 'remove', '--force', tree);
      rmSync(unrelated.dir, { recursive: true, force: true });
    }
  });

  it('falls back to HEAD for a new branch, which prints no range', () => {
    const { calls } = watch({
      command: 'git push -u origin HEAD',
      output: ' * [new branch]      HEAD -> feature\n',
      conclusion: 'success',
    });
    expect(calls).toContain(`--commit ${sha('HEAD')}`);
  });

  it('reads the commit in the directory the command ran in', () => {
    const other = scratchRepo();
    try {
      other.git(
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'z'
      );
      const head = spawnSync('git', ['-C', other.dir, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).stdout.trim();
      const { calls } = watch({
        command: 'git push -u origin HEAD',
        cwd: other.dir,
        project: repo.dir,
        conclusion: 'success',
      });
      expect(calls).toContain(`--commit ${head}`);
    } finally {
      rmSync(other.dir, { recursive: true, force: true });
    }
  });

  it('skips an up-to-date push, unless the same call opened a pull request', () => {
    const output = 'Everything up-to-date\n';
    expect(watch({ command: 'git push', output, conclusion: 'failure' }).calls).toBe('');
    const opened = watch({
      command: 'git push -u origin HEAD && gh pr create --fill',
      output,
      conclusion: 'failure',
    });
    expect(opened.status).toBe(2);
  });

  it('names each commit once, however many of its runs failed', () => {
    const result = watch({
      command: 'git push -u origin HEAD',
      runs: { 41: 'failure', 42: 'failure' },
    });
    expect(result.status).toBe(2);
    expect(result.stderr.match(/CI failed on/g).length).toBe(1);
    expect(result.stderr).toContain('Run 41:');
    expect(result.stderr).toContain('Run 42:');
  });

  it('reports what it found and what was still running when the watch runs out of time', () => {
    const started = Date.now();
    const result = watch({
      command: 'git push -u origin HEAD',
      runs: { 42: 'failure', 43: 'hang' },
      env: { CANON_CI_WATCH_BUDGET: '2' },
    });
    expect(Date.now() - started).toBeLessThan(20000);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Run 42:');
    expect(result.stderr).toContain(`CI had not finished run 43 on feature at ${sha('HEAD')}`);
    expect(result.stderr).not.toContain('run 42 on');
    // The watcher dies with the watch it waited on, so it never goes on to read the run.
    expect(result.calls).not.toContain('run view 43');
    expect(result.stderr).not.toContain('Terminated');
  });

  it('keeps a failure whose report the cutoff interrupted', () => {
    const result = watch({
      command: 'git push -u origin HEAD',
      runs: { 42: 'stall' },
      env: { CANON_CI_WATCH_BUDGET: '2' },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`CI failed on feature at ${sha('HEAD')}.`);
    expect(result.stderr).toContain('Run 42:');
    expect(result.stderr).not.toContain('had not finished');
  });

  it('says so when the cutoff comes before any run was listed', () => {
    const result = watch({
      command: 'git push -u origin HEAD',
      runs: {},
      env: { CANON_CI_WATCH_BUDGET: '2' },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`No CI run had registered on feature at ${sha('HEAD')}`);
  });

  it('names the repository in what it says to run for a run elsewhere', () => {
    const result = watch({
      command: 'gh pr create --repo up/r --fill',
      runs: { 43: 'hang' },
      env: { CANON_CI_WATCH_BUDGET: '2' },
    });
    expect(result.stderr).toContain('gh run watch 43 --exit-status -R up/r');
  });

  it('watches nothing for a quiet push that failed before it sent anything', () => {
    for (const output of [
      'fatal: The current branch feature has no upstream branch.\n',
      "fatal: 'nowhere' does not appear to be a git repository\n",
      'error: src refspec nope does not match any\n',
    ]) {
      const result = watch({ command: 'git push -q', output, conclusion: 'failure' });
      expect(result.calls, output).toBe('');
    }
    // Another command's error is not the push's, and nor is a remote's.
    for (const [command, output] of [
      ['git push -q', 'remote: error: something minor\n'],
      ['git push -q && cargo build', 'error: could not compile `app`\n'],
      ['git push -q && make', 'fatal: something else entirely\n'],
    ]) {
      expect(watch({ command, output, conclusion: 'failure' }).status, command).toBe(2);
    }
    // With two pushes the words cannot be pinned on one, so the one that sent is watched.
    const two = watch({
      command: 'git push -q origin feature && git push -q origin nope',
      output: 'error: src refspec nope does not match any\nerror: failed to push some refs\n',
      conclusion: 'failure',
    });
    expect(two.status).toBe(2);
    expect(two.stderr).toContain(`CI failed on feature at ${sha('HEAD')}.`);
  });

  it('watches a push with git options before the subcommand', () => {
    for (const command of ['git -c push.default=current push -q', 'git --no-pager push -q']) {
      const result = watch({ command, conclusion: 'failure' });
      expect(result.status, command).toBe(2);
      expect(result.stderr, command).toContain('CI failed on feature at');
    }
  });

  it('names the branch a quiet bare push wrote under push.default=upstream', () => {
    repo.git('remote', 'add', 'origin', join(repo.dir, 'nowhere.git'));
    repo.git('switch', '-q', '-c', 'wip');
    repo.git('config', 'branch.wip.remote', 'origin');
    repo.git('config', 'branch.wip.merge', 'refs/heads/feature');
    const result = watch({
      command: 'git -c push.default=upstream push -q',
      conclusion: 'failure',
    });
    expect(result.stderr).toContain('CI failed on feature at');
    expect(watch({ command: 'git push -q', conclusion: 'failure' }).stderr).toContain(
      'CI failed on wip at'
    );
    // Config given on the command is handed back to git as written: lowercased, `branch.Topic`
    // would not be `Topic`'s.
    repo.git('switch', '-q', '-c', 'Topic');
    const cased = watch({
      command:
        'git -c push.default=upstream -c branch.Topic.remote=origin -c branch.Topic.merge=refs/heads/feature push -q',
      conclusion: 'failure',
    });
    expect(cased.stderr).toContain('CI failed on feature at');
  });

  it('starts no Node for a command that only mentions push beside a path with git in it', () => {
    const nodes = join(bin, 'node.log');
    writeFileSync(join(bin, 'node'), `#!/bin/sh\necho "$1" >> '${nodes}'\nexit 0\n`, {
      mode: 0o755,
    });
    for (const command of ['pushd sub', 'npm run push-docs', 'echo push']) {
      const result = spawnSync('bash', [join(HOOKS, 'ci-watch.sh')], {
        input: JSON.stringify({
          session_id: 's',
          transcript_path: '/home/me/git/app/t.jsonl',
          cwd: '/home/me/git/app',
          tool_name: 'Bash',
          tool_input: { command, description: 'push it' },
          tool_response: { stdout: '' },
        }),
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      });
      expect(result.status, command).toBe(0);
    }
    expect(existsSync(nodes)).toBe(false);
  });

  it('stays silent outside a canon project', () => {
    rmSync(join(repo.dir, '.claude/canon.json'));
    const result = watch({ command: 'git push -u origin HEAD', conclusion: 'failure' });
    expect(result.status).toBe(0);
    expect(result.calls).toBe('');
  });

  describe('which commands start a run', () => {
    /** Write `ci.yml` with `on` as its triggers, and point `ci.workflow` at it unless `ci` is false. */
    function workflow(on, { ci = true } = {}) {
      writeFileSync(
        join(repo.dir, '.claude/canon.json'),
        JSON.stringify(ci ? { ...CONFIG, ci: { workflow: 'ci.yml', baseInput: null } } : CONFIG)
      );
      mkdirSync(join(repo.dir, '.github/workflows'), { recursive: true });
      writeFileSync(
        join(repo.dir, '.github/workflows/ci.yml'),
        `name: CI\n${on}\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n`
      );
    }

    const PUSH = 'git push -u origin HEAD';
    const CREATE = 'gh pr create --fill';
    const READY = 'gh pr ready 12';
    // A pull request named by number is watched only when gh can read its head.
    const watched = (command) =>
      watch({ command, conclusion: 'failure', prHead: `${sha('HEAD')} feature` });

    /** Watched means it polled and reported the red run; ignored means it never called gh. */
    function expectWatched(command) {
      const result = watched(command);
      expect(result.status, command).toBe(2);
      expect(result.calls, command).toContain('run list');
      expect(result.stderr, command).toContain('CI failed on feature');
    }
    function expectIgnored(command) {
      const result = watched(command);
      expect(result.status, command).toBe(0);
      expect(result.calls, command).toBe('');
      expect(result.stderr, command).toBe('');
    }

    it("uses GitHub's default types with no ci block, so marking a draft ready is ignored", () => {
      expectWatched(PUSH);
      expectWatched(CREATE);
      expectIgnored(READY);
    });

    it('uses the default types when no workflow is there to read', () => {
      workflow('on: pull_request');
      rmSync(join(repo.dir, '.github/workflows/ci.yml'));
      expectWatched(PUSH);
      expectIgnored(READY);
    });

    it('reads the workflows without a ci block', () => {
      workflow('on:\n  pull_request:\n    types: [opened, ready_for_review]', { ci: false });
      expectWatched(READY);
      expectIgnored(PUSH);
    });

    it('watches ready_for_review and ignores a push when the types leave out synchronize', () => {
      workflow(
        'on:\n  pull_request:\n    types: [opened, reopened, ready_for_review]\n  workflow_dispatch:'
      );
      expectWatched(READY);
      expectWatched(CREATE);
      expectIgnored(PUSH);
    });

    it('reads types written as a block list, at either indent', () => {
      workflow('on:\n  pull_request:\n    types:\n      - opened\n      - ready_for_review');
      expectWatched(READY);
      expectIgnored(PUSH);
      workflow('on:\n  pull_request:\n    types:\n    - "ready_for_review"   # drafts');
      expectWatched(READY);
      expectIgnored(CREATE);
    });

    it('takes a pull_request key with no types as the defaults', () => {
      workflow('on:\n  pull_request:\n    branches: [staging]');
      expectWatched(PUSH);
      expectIgnored(READY);
    });

    it('watches a push when push is a trigger', () => {
      workflow('on: [push, pull_request]');
      expectWatched(PUSH);
      expectIgnored(READY);
      workflow('on: push');
      expectWatched(PUSH);
      expectIgnored(CREATE);
      workflow('on:\n  push:\n    branches: [feature]\n  pull_request:\n    types: [opened]');
      expectWatched(PUSH);
    });

    it('still skips an up-to-date push under a push trigger', () => {
      workflow('on: [push]');
      const result = watch({ command: 'git push', output: 'Everything up-to-date\n' });
      expect(result.status).toBe(0);
      expect(result.calls).toBe('');
    });

    /** Another workflow file beside `ci.yml`, in `dir`'s `.github/workflows/`. */
    function another(name, on, dir = repo.dir) {
      mkdirSync(join(dir, '.github/workflows'), { recursive: true });
      writeFileSync(join(dir, '.github/workflows', name), `${on}\njobs: {}\n`);
    }
    const TRIMMED = 'on:\n  pull_request:\n    types: [opened, reopened, ready_for_review]';

    it('watches a push when another workflow keeps the synchronize type ci.yml trimmed', () => {
      workflow(TRIMMED);
      another('lint.yml', 'on: pull_request');
      expectWatched(PUSH);
    });

    it('ignores a workflow on other events only, such as a release on tags', () => {
      workflow(TRIMMED);
      another('release.yml', "on:\n  push:\n    tags: ['v*']\n  release: {types: [published]}");
      another(
        'dispatch.yml',
        'on:\n  workflow_dispatch:\n    inputs:\n      base:\n        type: string'
      );
      expectIgnored(PUSH);
      expectWatched(READY);
    });

    it('leaves out pull_request_target, whose runs are on the base commit', () => {
      workflow('on:\n  pull_request:\n    types: [opened]');
      another('target.yml', 'on:\n  pull_request_target:\n    types: [ready_for_review]');
      expectIgnored(READY);
    });

    it('keeps a quoted # in a filter, which is not a comment', () => {
      workflow(`${TRIMMED}\n  push:\n    branches-ignore: ['feature', 'hotfix #1']  # not these`);
      expectIgnored(PUSH);
    });

    it('ignores gh pr ready --repo with no selector, which gh refuses', () => {
      workflow(TRIMMED);
      expectIgnored('gh pr ready -R o/r');
      expectIgnored('gh pr -R o/r ready');
    });

    it('lets other gh pr commands through without a lookup', () => {
      workflow(TRIMMED);
      expectIgnored('gh pr view 12');
      expectIgnored('gh pr checks 12');
    });

    it("honours a push trigger's branch filters", () => {
      workflow(`${TRIMMED}\n  push:\n    branches: [staging, 'release/**']`);
      expectIgnored(PUSH);
      workflow(`${TRIMMED}\n  push:\n    branches:\n      - 'feat*'`);
      expectWatched(PUSH);
      workflow(`${TRIMMED}\n  push:\n    branches-ignore: [feature]`);
      expectIgnored(PUSH);
      workflow(`${TRIMMED}\n  push:\n    branches-ignore: [main]`);
      expectWatched(PUSH);
    });

    it('ignores gh pr ready --undo, which converts the pull request to a draft', () => {
      workflow(TRIMMED);
      expectIgnored('gh pr ready 12 --undo');
      expectIgnored('gh pr ready --undo');
    });

    it('watches gh pr reopen when reopened is a type, and only then', () => {
      expectWatched('gh pr reopen 12');
      workflow('on:\n  pull_request:\n    types: [opened]');
      expectIgnored('gh pr reopen 12');
    });

    it('watches the head of the pull request marked ready, not HEAD', () => {
      workflow(TRIMMED);
      const head = 'abc1234abc1234abc1234abc1234abc1234abcd';
      const result = watch({
        command: 'gh pr ready -R o/r 12',
        conclusion: 'failure',
        prHead: `${head} other-branch`,
      });
      expect(result.status).toBe(2);
      expect(result.calls).toContain('pr view 12 --repo o/r --json');
      expect(result.calls).toContain(`run list --commit ${head}`);
      expect(result.stderr).toContain(`CI failed on other-branch at ${head}.`);
      // The group flag before the subcommand, as gh takes it.
      const group = watch({
        command: 'gh pr -R o/r ready 12',
        conclusion: 'failure',
        prHead: `${head} other-branch`,
      });
      expect(group.status).toBe(2);
      expect(group.calls).toContain('pr view 12 --repo o/r --json');
      // pflag reads `-R=o/r` as `o/r`.
      const equals = watch({
        command: 'gh pr ready -R=o/r 12',
        conclusion: 'failure',
        prHead: `${head} other-branch`,
      });
      expect(equals.calls).toContain('pr view 12 --repo o/r --json');
    });

    it('stays quiet when gh cannot read the pull request a ready names', () => {
      workflow(TRIMMED);
      const result = watch({ command: 'gh pr ready 12', conclusion: 'failure', prHead: '' });
      expect(result.status).toBe(0);
      expect(result.calls).toContain('pr view 12');
      expect(result.calls).not.toContain('run list');
    });

    it('watches both the push and the pull request marked ready in the same call', () => {
      workflow(TRIMMED);
      another('push.yml', 'on:\n  push:\n    branches: [feature]');
      const head = 'abc1234abc1234abc1234abc1234abc1234abcd';
      const result = watch({
        command: 'git push origin feature && gh pr ready 12',
        output: `   0000000..${sha('HEAD').slice(0, 7)}  feature -> feature\n`,
        conclusion: 'failure',
        prHead: `${head} other`,
      });
      expect(result.status).toBe(2);
      expect(result.calls).toContain(`run list --commit ${sha('HEAD')}`);
      expect(result.calls).toContain(`run list --commit ${head}`);
      expect(result.stderr).toContain(`CI failed on other at ${head}.`);
    });

    it('reads a push with no ref line from its refspec, not the branch checked out', () => {
      workflow(`${TRIMMED}\n  push:\n    branches: [main]`);
      repo.git('checkout', '-q', '--detach');
      const detached = watch({ command: 'git push -q origin HEAD:main', conclusion: 'failure' });
      expect(detached.status).toBe(2);
      expect(detached.stderr).toContain(`CI failed on main at ${sha('HEAD')}.`);
      repo.git('checkout', '-q', 'feature');
      repo.git(
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'y'
      );
      repo.git('branch', 'other', 'HEAD~1');
      workflow(`${TRIMMED}\n  push:\n    branches: [other]`);
      const other = watch({ command: 'git push -q origin other', conclusion: 'failure' });
      expect(other.calls).toContain(`run list --commit ${sha('other')}`);
      expect(other.calls).not.toContain(`run list --commit ${sha('HEAD')}`);
      expect(other.stderr).toContain(`CI failed on other at ${sha('other')}.`);
      // A refspec that names a branch the filters leave out starts nothing.
      expect(watch({ command: 'git push -q origin HEAD:main', conclusion: 'failure' }).calls).toBe(
        ''
      );
    });

    it('watches a push beside another that was up to date', () => {
      workflow(`${TRIMMED}\n  push:\n    branches: [feature]`);
      const result = watch({
        command: 'git push origin feature && git push upstream feature',
        output: `   0000000..${sha('HEAD').slice(0, 7)}  feature -> feature\nEverything up-to-date\n`,
        conclusion: 'failure',
      });
      expect(result.status).toBe(2);
      expect(result.calls).toContain(`run list --commit ${sha('HEAD')}`);
    });

    it('looks up every pull request marked ready in one call', () => {
      workflow(TRIMMED);
      const result = watched('gh pr ready 12 && gh pr ready 13');
      expect(result.calls).toContain('pr view 12 --json');
      expect(result.calls).toContain('pr view 13 --json');
    });

    it('watches gh pr create --repo in the repository it names', () => {
      const result = watched('gh pr create --repo up/r --fill');
      expect(result.status).toBe(2);
      expect(result.calls).toContain(`[up/r] run list --commit ${sha('HEAD')}`);
    });

    it('watches a commit once when --repo names the checkout itself', () => {
      workflow(`${TRIMMED}\n  push:\n    branches: [feature]`);
      const result = watch({
        command: 'git push && gh pr ready --repo Me/This 12',
        output: `   0000000..${sha('HEAD').slice(0, 7)}  feature -> feature\n`,
        conclusion: 'failure',
        prHead: `${sha('HEAD')} feature`,
        ownRepo: 'me/this',
      });
      expect(result.status).toBe(2);
      // One look and one for the stragglers, for one commit.
      expect(result.calls.match(/run list/g).length).toBe(2);
      expect(result.stderr.match(/CI failed/g).length).toBe(1);
    });

    it('keeps the pull request when the push lookups fail', () => {
      const git = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
      writeFileSync(
        join(bin, 'git'),
        `#!/bin/sh\ncase "$*" in *cat-file*|*for-each-ref*) exit 1 ;; esac\nexec '${git}' "$@"\n`,
        { mode: 0o755 }
      );
      const result = watch({
        command: 'git push origin feature && gh pr create --fill',
        output: `   0000000..${sha('HEAD').slice(0, 7)}  feature -> feature\n`,
        conclusion: 'failure',
      });
      expect(result.status).toBe(2);
      expect(result.calls).toContain(`run list --commit ${sha('HEAD')}`);
    });

    it('watches nothing for a push git rejected', () => {
      workflow(`${TRIMMED}\n  push:\n    branches: [main]`);
      for (const output of [
        ' ! [rejected]        main -> main (non-fetch first)\nerror: failed to push some refs\n',
        ' ! [remote rejected] main -> main (protected branch hook declined)\n',
      ]) {
        const result = watch({ command: 'git push -q origin HEAD:main', output });
        expect(result.calls, output).toBe('');
      }
    });

    it('watches the branch gh pr create --head names, not HEAD', () => {
      repo.git(
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'y'
      );
      repo.git('branch', 'other', 'HEAD~1');
      const result = watched('gh pr create --head owner:other --base staging --fill');
      expect(result.calls).toContain(`run list --commit ${sha('other')}`);
      expect(result.calls).not.toContain(`run list --commit ${sha('HEAD')}`);
      expect(result.stderr).toContain(`CI failed on other at ${sha('other')}.`);
    });

    it('watches gh pr create --repo whatever the local types say, as a ready does', () => {
      workflow('on:\n  pull_request:\n    types: [ready_for_review]');
      expectIgnored(CREATE);
      expect(watched('gh pr create --repo up/x --fill').calls).toContain('[up/x] run list');
    });

    it('falls back to the plain reading when the full one fails', () => {
      const head = { sha: 'a'.repeat(40), name: 'feature' };
      const on = { sha: head.sha, label: 'feature', repo: '' };
      expect(textTargets('git push', '', head)).toEqual([on]);
      expect(textTargets('gh pr create --fill', '', head)).toEqual([on]);
      expect(textTargets('git push', 'Everything up-to-date', head)).toEqual([]);
      expect(textTargets('git push', ' ! [rejected] main -> main', head)).toEqual([]);
      expect(textTargets('gh pr ready 12', '', head)).toEqual([]);
    });

    it('returns no targets, never throws, for a directory that is not a repository', () => {
      const command = { tool_input: { command: 'git push' } };
      expect(watchTargets({ ...command, cwd: tmpdir() }, '').targets).toEqual([]);
      expect(watchTargets(null, '').targets).toEqual([]);
    });

    it('reads the selector from the ready command alone, not the next line', () => {
      workflow(TRIMMED);
      const result = watch({ command: 'gh pr ready\necho done', conclusion: 'failure' });
      expect(result.status).toBe(2);
      expect(result.calls).toContain('pr view --json');
      expect(
        watch({ command: 'gh pr ready\ngit stash --undo', conclusion: 'failure' }).status
      ).toBe(2);
    });

    it('reads --undo=true as an undo and --undo=false as a ready', () => {
      workflow(TRIMMED);
      expectIgnored('gh pr ready 12 --undo=true');
      expectWatched('gh pr ready 12 --undo=false');
    });

    it('keeps watching a push when a branches-ignore pattern is one it cannot read', () => {
      workflow(`${TRIMMED}\n  push:\n    branches-ignore: ['release/[0-9]*']`);
      expectWatched(PUSH);
    });

    it('watches a tag push when a workflow runs on tags', () => {
      workflow(TRIMMED);
      another('release.yml', "on:\n  push:\n    tags: ['v*']");
      repo.git('tag', 'v1.2.0');
      const output = ' * [new tag]         v1.2.0 -> v1.2.0\n';
      const tagged = watch({ command: 'git push origin v1.2.0', output, conclusion: 'failure' });
      expect(tagged.status).toBe(2);
      expect(tagged.stderr).toContain(`CI failed on v1.2.0 at ${sha('v1.2.0')}.`);
      // A branch push under the same files starts nothing.
      expectIgnored(PUSH);
    });

    it('decides a tag push by tag triggers alone', () => {
      repo.git('tag', 'v1.2.0');
      const output = ' * [new tag]         v1.2.0 -> v1.2.0\n';
      const tagPush = () =>
        watch({ command: 'git push origin v1.2.0', output, conclusion: 'failure' });
      // The default types start nothing for a tag.
      expect(tagPush().calls).toBe('');
      workflow(`${TRIMMED}\n  push:\n    branches: [feature]`);
      expect(tagPush().calls).toBe('');
    });

    it('reads a file whose run script has a tab, outside on:', () => {
      workflow(TRIMMED);
      another(
        'release.yml',
        "on:\n  push:\n    tags: ['v*']\njobs:\n  r:\n    steps:\n      - run: |\n\t\tmake release"
      );
      repo.git('tag', 'v1.2.0');
      const output = ' * [new tag]         v1.2.0 -> v1.2.0\n';
      expect(
        watch({ command: 'git push origin v1.2.0', output, conclusion: 'failure' }).status
      ).toBe(2);
    });

    it('reads a forced tag update as a tag push', () => {
      workflow(TRIMMED);
      another('release.yml', "on:\n  push:\n    tags: ['v*']");
      repo.git('tag', 'v1');
      const old = sha('HEAD').slice(0, 7);
      repo.git(
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'y'
      );
      repo.git('tag', '-f', 'v1');
      const now = sha('HEAD').slice(0, 7);
      const result = watch({
        command: 'git push -f origin v1',
        output: ` + ${old}...${now} v1 -> v1 (forced update)\n`,
        conclusion: 'failure',
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`CI failed on v1 at ${sha('HEAD')}.`);
    });

    it('counts no tag push for --follow-tags that sent no tag', () => {
      workflow(TRIMMED);
      another('release.yml', "on:\n  push:\n    tags: ['v*']");
      const result = watch({
        command: 'git push --follow-tags',
        output: `   ${sha('HEAD').slice(0, 7)}..${sha('HEAD').slice(0, 7)}  feature -> feature\n`,
        conclusion: 'failure',
      });
      expect(result.calls).toBe('');
    });

    it('watches a ready in another repository whatever the local workflows say', () => {
      workflow('on:\n  pull_request:\n    types: [opened]');
      const result = watched('gh pr ready 7 --repo org/other');
      expect(result.status).toBe(2);
      expect(result.calls).toContain('pr view 7 --repo org/other --json');
    });

    it('watches the tag --follow-tags sent on another commit when only tags start a run', () => {
      workflow(TRIMMED);
      another('release.yml', "on:\n  push:\n    tags: ['v*']");
      repo.git('tag', 'v1.2');
      repo.git(
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'y'
      );
      const result = watch({
        command: 'git push --follow-tags origin feature',
        output: `   ${sha('HEAD~1').slice(0, 7)}..${sha('HEAD').slice(0, 7)}  feature -> feature\n * [new tag]         v1.2 -> v1.2\n`,
        conclusion: 'failure',
      });
      expect(result.status).toBe(2);
      expect(result.calls).toContain(`run list --commit ${sha('v1.2')}`);
      expect(result.calls).not.toContain(`run list --commit ${sha('HEAD')}`);
      expect(result.stderr).toContain(`CI failed on v1.2 at ${sha('v1.2')}.`);
    });

    it('watches the branch a push sent and the tag it carried, each on its own commit', () => {
      workflow(TRIMMED);
      another('release.yml', "on:\n  push:\n    branches: [feature]\n    tags: ['v*']");
      repo.git('tag', 'v1.0');
      repo.git(
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'y'
      );
      const old = sha('HEAD~1').slice(0, 7);
      const now = sha('HEAD').slice(0, 7);
      const result = watch({
        command: 'git push --follow-tags origin feature',
        output: `   ${old}..${now}  feature -> feature\n * [new tag]         v1.0 -> v1.0\n`,
        conclusion: 'failure',
      });
      expect(result.status).toBe(2);
      expect(result.calls).toContain(`run list --commit ${sha('HEAD')}`);
      expect(result.stderr).toContain(`CI failed on feature at ${sha('HEAD')}.`);
      expect(result.calls).toContain(`run list --commit ${sha('v1.0')}`);
      expect(result.stderr).toContain(`CI failed on v1.0 at ${sha('v1.0')}.`);
    });

    it('watches the annotated tag a quiet --follow-tags push sent', () => {
      workflow(TRIMMED);
      another('release.yml', "on:\n  push:\n    tags: ['v*']");
      repo.git('-c', 'user.name=t', '-c', 'user.email=t@t', 'tag', '-a', 'v1.2', '-m', 'v1.2');
      for (const command of ['git push -q --follow-tags', 'git -c push.followTags=true push -q']) {
        const result = watch({ command, conclusion: 'failure' });
        expect(result.status, command).toBe(2);
        expect(result.stderr, command).toContain(`CI failed on v1.2 at ${sha('HEAD')}.`);
      }
      // A -c with no value is true to git.
      expect(
        watch({ command: 'git -c push.followTags push -q', conclusion: 'failure' }).status
      ).toBe(2);
      // Without it, with the flag that turns it off whatever the config says, or with the config
      // set false, nothing.
      for (const command of [
        'git push -q',
        'git -c push.followTags=true push -q --no-follow-tags',
        'git -c push.followTags=false push -q',
      ]) {
        expect(watch({ command, conclusion: 'failure' }).calls, command).toBe('');
      }
      repo.git('config', 'push.followTags', 'true');
      expect(watch({ command: 'git push -q --no-follow-tags', conclusion: 'failure' }).calls).toBe(
        ''
      );
      expect(watch({ command: 'git push -q', conclusion: 'failure' }).status).toBe(2);
      repo.git('config', '--unset', 'push.followTags');
      repo.git('tag', '-d', 'v1.2');
      repo.git('tag', 'v1.3');
      expect(watch({ command: 'git push -q --follow-tags', conclusion: 'failure' }).calls).toBe('');
    });

    it('stays quiet when the reader fails, and starts no Node for other commands', () => {
      workflow(TRIMMED);
      const nodes = join(bin, 'node.log');
      writeFileSync(
        join(bin, 'node'),
        `#!/bin/sh\necho "$1" >> '${nodes}'\ncase "$1" in *ci-triggers.mjs) exit 1 ;; esac\nexec '${process.execPath}' "$@"\n`,
        { mode: 0o755 }
      );
      for (const command of [PUSH, CREATE, READY]) expectIgnored(command);
      rmSync(nodes, { force: true });
      expectIgnored('git status');
      // Output that mentions one is not one, and neither is another gh pr command.
      watch({ command: 'git log', output: 'gh pr ready 12, then git push\n' });
      expectIgnored('gh pr view 12');
      expectIgnored('gh pr checks 12');
      expect(existsSync(nodes)).toBe(false);
    });

    it('reads the triggers when the plugin is reached through a symlink', () => {
      workflow(TRIMMED);
      const link = join(mkdtempSync(join(tmpdir(), 'canon-link-')), 'hooks');
      symlinkSync(HOOKS, link);
      try {
        const result = watch({
          command: READY,
          conclusion: 'failure',
          prHead: `${sha('HEAD')} feature`,
          script: join(link, 'ci-watch.sh'),
        });
        expect(result.status).toBe(2);
        expect(watch({ command: PUSH, script: join(link, 'ci-watch.sh') }).calls).toBe('');
      } finally {
        rmSync(join(link, '..'), { recursive: true, force: true });
      }
    });

    it('watches gh pr ready after an up-to-date push in the same call', () => {
      workflow(TRIMMED);
      const result = watch({
        command: 'git push && gh pr ready',
        output: 'Everything up-to-date\n',
        conclusion: 'failure',
      });
      expect(result.status).toBe(2);
      expect(result.calls).toContain('pr view --json');
    });

    it("reads a worktree's own workflows, with the config from the project", () => {
      workflow('on:\n  pull_request:\n    types: [opened]');
      const tree = mkdtempSync(join(tmpdir(), 'canon-tree-'));
      rmSync(tree, { recursive: true });
      repo.git('worktree', 'add', '-q', '--detach', tree, 'HEAD');
      try {
        rmSync(join(tree, '.claude/canon.json'), { force: true });
        another('ci.yml', TRIMMED, tree);
        const result = watch({
          command: READY,
          cwd: tree,
          conclusion: 'failure',
          prHead: `${sha('HEAD')} feature`,
        });
        expect(result.status).toBe(2);
      } finally {
        repo.git('worktree', 'remove', '--force', tree);
      }
    });

    it('falls back to the defaults for a workflow it cannot read, never to watching nothing', () => {
      for (const on of [
        'on: {pull_request: {types: [ready_for_review]}}',
        'on:\n  pull_request: {types: [ready_for_review]}',
        'on:\n  pull_request:\n    types: [ready_for_review, &anchor]',
        'on:\n  workflow_dispatch:',
        'triggers: nonsense',
        'on:\n\tpull_request:',
      ]) {
        workflow(on);
        expectWatched(PUSH);
        expectWatched(CREATE);
        expectIgnored(READY);
      }
    });
  });
});
