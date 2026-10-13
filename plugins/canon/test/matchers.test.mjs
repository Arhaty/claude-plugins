/**
 * The matchers behind the hooks: does a command write the project, push, or merge,
 * and where to. Each is a list of shapes rather than a parser, which makes them
 * exactly the kind of code that needs examples rather than review.
 *
 * The cases come from the two projects this workflow was extracted from, where
 * each one was a real miss or a real false refusal.
 */

import { describe, expect, it } from './helpers.mjs';

import {
  commandSkeleton,
  mergeTargets,
  mergesIn,
  prCalls,
  prDetails,
  prFiles,
  prInvocations,
  prSubcommand,
} from '../hooks/lib/merge-command.mjs';
import { pushTargets } from '../hooks/lib/push-command.mjs';
import { writesToWorktree } from '../hooks/lib/writes-to-worktree.mjs';

/**
 * These two helpers decide whether a hook fires, so a false positive blocks legitimate work and a
 * false negative lets the thing the hook exists for through. Both are lists of shapes rather than
 * parsers, which makes them exactly the kind of code that needs examples rather than review.
 *
 * The cases that matter most are the ones where the words appear but the command does not run: a
 * commit message describing these hooks is the canonical example, and a regex against the raw string
 * refuses it.
 */

describe('writesToWorktree', () => {
  it.each([
    ['cat src/app/page.tsx', false],
    ['grep -rn Hero src/components', false],
    ['pnpm lint 2>&1', false],
    ['pnpm test', false],
    ['git status', false],
    ['echo hello > /dev/null', false],
    ['echo hello > /tmp/scratch.txt', false],
    ['echo hello > $TMPDIR/scratch.txt', false],
  ])('reads only: %s', (command, expected) => {
    expect(writesToWorktree(command)).toBe(expected);
  });

  it.each([
    ['echo x > src/app/page.tsx', true],
    ['cat > src/new.ts <<EOF\nhi\nEOF', true],
    ["sed -i '' s/a/b/ src/x.ts", true],
    ['node -e "require(\'fs\').writeFileSync(1,2)"', true],
    ['python3 -c "open(1)"', true],
    ['git commit -m wip', true],
    ['git checkout -- src/', true],
    ['rm src/x.ts', true],
    ['mv a b', true],
  ])('writes: %s', (command, expected) => {
    expect(writesToWorktree(command)).toBe(expected);
  });

  it('ignores a duplicated descriptor, which writes nothing', () => {
    // `2>&1` looks like a redirect and is not one. Without the strip, every command that captures
    // stderr counts as a write and the branch guard fires on `pnpm lint`.
    expect(writesToWorktree('pnpm typecheck 2>&1 | tail -5')).toBe(false);
  });

  it('is false for a non-string', () => {
    expect(writesToWorktree(undefined)).toBe(false);
    expect(writesToWorktree(null)).toBe(false);
  });

  // Regressions. Each of these was a false positive that refused an ordinary read on a protected
  // branch, which is the failure mode that teaches people to set the bypass and leave it set.
  it.each([
    // `install` is the one write verb that is also a package-manager subcommand, and this is the
    // first command CI runs.
    ['pnpm install --frozen-lockfile'],
    ['npm install --save-dev vitest'],
    // A `>` inside a quoted span is a comparison or a literal, not a redirect.
    ["awk '$1 > 2' data.txt"],
    ['grep -n ">" src/app/page.tsx'],
    ['echo "a > b"'],
  ])('does not flag: %s', (command) => {
    expect(writesToWorktree(command)).toBe(false);
  });

  it.each([
    // BSD install at a command position is still a write.
    ['install -m 644 a b'],
    ['cd x && install -m 644 a b'],
    // A verb at the very end of the string has no trailing space to match on.
    ['find . -name "*.tmp" | xargs rm'],
    // A quoted string does not make the redirect after it disappear.
    ['echo "hello world" > src/x.ts'],
  ])('still flags: %s', (command) => {
    expect(writesToWorktree(command)).toBe(true);
  });
});

describe('commandSkeleton', () => {
  it('removes a quoted body', () => {
    expect(
      commandSkeleton("gh pr create --body-file - <<'EOF'\ngh pr merge is refused\nEOF")
    ).not.toContain('gh pr merge');
  });

  it('removes an unquoted body', () => {
    expect(commandSkeleton('cat <<EOF\npnpm build\nEOF')).not.toContain('pnpm build');
  });

  it('leaves a command with no heredoc alone', () => {
    expect(commandSkeleton('gh pr merge 12')).toBe('gh pr merge 12');
  });

  it('keeps a redirect that sits on the command line rather than in the body', () => {
    // `cat <<EOF > src/x.ts` writes a file, and writesToWorktree has to still see the target after
    // the body is gone.
    expect(commandSkeleton('cat <<EOF > src/x.ts\nbody\nEOF')).toContain('> src/x.ts');
  });

  it('removes the opener, so a following command survives', () => {
    // The regression this function existed to have: leaving `<<EOF` in place made the next pass read
    // it over a string with no terminator, call it unterminated, and discard everything after it.
    // Every hook that asks this question then went blind after any heredoc.
    const command = 'cat <<EOF > /tmp/body.md\nprose\nEOF\ngh pr merge 42 --squash';
    expect(commandSkeleton(command)).toContain('gh pr merge 42');
    expect(commandSkeleton(command)).not.toContain('<<EOF');
    expect(commandSkeleton(command)).not.toContain('prose');
  });

  it('terminates on several heredocs in one command', () => {
    const command = 'cat <<A > x\n1\nA\ncat <<B > y\n2\nB\ngh pr merge 9';
    expect(commandSkeleton(command)).toContain('gh pr merge 9');
  });

  it('still swallows the rest of a genuinely unterminated heredoc', () => {
    // An interactive shell would sit waiting for the terminator, so nothing after it has run.
    expect(commandSkeleton('cat <<EOF\nnot closed\ngh pr merge 5')).not.toContain('gh pr merge');
  });

  it('does not treat a <<WORD inside quotes as a heredoc opener', () => {
    // The fail-open regression, and the worst of the set. The quoted `<<EOF` was read as an opener,
    // found no terminator, and discarded the rest of the command — so protect-merge stopped seeing
    // the merge and allowed one into main.
    const command =
      'gh pr edit 42 --body "documents the <<EOF body style\nsee the hook docs"\ngh pr merge 42 --merge';
    expect(commandSkeleton(command)).toContain('gh pr merge 42');
  });

  it('defuses a separator inside quotes', () => {
    // The fail-closed case: the `(` in the message looked like a command separator, which put
    // `gh pr merge` at an apparent command position and refused an ordinary commit.
    //
    // In the default mode the *words* survive — that is what lets a quoted selector or refspec be
    // read — so what this asserts is that the parenthesis no longer reads as syntax, and that the
    // matcher built on it reaches the right answer.
    const command = 'git commit -m "feat: protect main (gh pr merge is refused)"';
    const skeleton = commandSkeleton(command);
    expect(skeleton).toContain('git commit');
    expect(skeleton).not.toContain('(');
    expect(prSubcommand(command, ['merge'])).toBeNull();

    // With quoted spans dropped, which is what a verb matcher reads, the words go too.
    expect(commandSkeleton(command, { quoted: 'drop' })).not.toContain('gh pr merge');
  });

  it('carries quote state across lines', () => {
    // A double-quoted argument can span newlines, which is why this needs a scanner and not a
    // per-line regex.
    expect(commandSkeleton('gh pr edit 1 --body "line one\nline two"\ngh pr merge 1')).toContain(
      'gh pr merge 1'
    );
  });

  it('does not let an apostrophe in a heredoc body open a quote', () => {
    // Quote state is suspended inside a body. Without that, "it's" opens a single-quoted span that
    // never closes and swallows the merge after the terminator.
    const command = "cat <<EOF > b.md\nit's really fine\nEOF\ngh pr merge 77";
    expect(commandSkeleton(command)).toContain('gh pr merge 77');
  });

  it('leaves a herestring alone', () => {
    // `<<<` has no body and is not a heredoc.
    expect(commandSkeleton('grep x <<< "$data"\ngh pr merge 3')).toContain('gh pr merge 3');
  });
});

describe('prSubcommand', () => {
  it('finds a plain merge and its selector', () => {
    expect(prSubcommand('gh pr merge 12 --merge', ['merge'])).toEqual({
      subcommand: 'merge',
      selector: ['12'],
      unresolved: false,
    });
  });

  it('finds a merge with no selector, meaning the current branch', () => {
    expect(prSubcommand('gh pr merge --merge', ['merge'])).toEqual({
      subcommand: 'merge',
      selector: [],
      unresolved: false,
    });
  });

  it('finds a subcommand after a separator', () => {
    expect(prSubcommand('git push && gh pr create --fill', ['create'])?.subcommand).toBe('create');
  });

  it('finds one through an inline environment assignment', () => {
    expect(
      prSubcommand('ALLOW_UNDECIDED_MERGE=1 gh pr create --fill', ['create'])?.subcommand
    ).toBe('create');
  });

  it('does not match the words inside an echo', () => {
    expect(prSubcommand('echo "then run gh pr merge"', ['merge'])).toBeNull();
  });

  it('does not match a commit message describing the hooks', () => {
    // The case that motivates commandSkeleton: this exact commit is what a raw regex refuses.
    const command = "git commit -F - <<'EOF'\nfeat: refuse gh pr merge into main\nEOF";
    expect(prSubcommand(command, ['merge'])).toBeNull();
  });

  it('finds a real merge that follows a heredoc', () => {
    // The other half of the same regression, and the dangerous half: writing a PR body with a
    // heredoc and then merging in the same call is the normal shape of a release, and it was
    // invisible to protect-merge.
    expect(
      prSubcommand('gh pr edit 42 --body-file - <<EOF\nwhat changed\nEOF\ngh pr merge 42', [
        'merge',
      ])
    ).toEqual({ subcommand: 'merge', selector: ['42'], unresolved: false });
  });

  it('does not match a different subcommand', () => {
    expect(prSubcommand('gh pr view 12', ['merge', 'create'])).toBeNull();
  });

  it('matches only the subcommands it is given', () => {
    expect(prSubcommand('gh pr create --fill', ['merge'])).toBeNull();
    expect(prSubcommand('gh pr create --fill', ['create', 'ready', 'merge'])?.subcommand).toBe(
      'create'
    );
  });

  it('is null for a non-string', () => {
    expect(prSubcommand(undefined, ['merge'])).toBeNull();
  });
});

it('flags a selector it cannot evaluate', () => {
  // `gh pr merge $PR` is an ordinary thing to write. The hook still refuses it, because the base
  // branch is unknown, but it has to say "name the number" rather than report a lookup failure.
  expect(prSubcommand('gh pr merge $PR_NUMBER --merge', ['merge'])).toEqual({
    subcommand: 'merge',
    selector: ['$PR_NUMBER'],
    unresolved: true,
  });
  expect(prSubcommand('gh pr merge `cat n` --merge', ['merge'])?.unresolved).toBe(true);
  expect(prSubcommand('gh pr merge 42 --merge', ['merge'])?.unresolved).toBe(false);
});

describe('mergeTargets', () => {
  it('reads a merge and its selector, and nothing else', () => {
    expect(mergeTargets('gh pr merge 7')).toEqual([{ selector: ['7'] }]);
    expect(mergeTargets('gh pr create --fill')).toEqual([]);
  });
});

describe('pushTargets', () => {
  it('is null when the command does not push', () => {
    expect(pushTargets('pnpm lint')).toBeNull();
    expect(pushTargets('git commit -m "direct push to staging is refused"')).toBeNull();
    expect(pushTargets(undefined)).toBeNull();
  });

  it('reports a bare push, whose target depends on configuration', () => {
    // toMatchObject, not toEqual: these assertions are about `targets` and `bare`, and pinning the
    // whole shape made them break every time a new field was added — three times so far, each a
    // false failure that said nothing about the behaviour under test.
    expect(pushTargets('git push')).toMatchObject({ targets: [], bare: true });
  });

  it.each([
    ['git push origin HEAD:staging', ['staging']],
    ['git push origin HEAD:main', ['main']],
    ['git push origin staging', ['staging']],
    // A leading + is a force, and refs/heads/ is the long form of the same branch.
    ['git push origin +HEAD:main', ['main']],
    ['git push origin refs/heads/main', ['main']],
    // --delete would remove the branch, which is still writing to it.
    ['git push --delete origin staging', ['staging']],
    // A flag taking a value must not be read as the remote.
    ['git push -o ci.skip origin HEAD:staging', ['staging']],
    // The shape a feature branch is pushed with. HEAD is resolved by the hook, not here.
    ['git push -u origin HEAD', ['HEAD']],
    ['git push origin feat/thing', ['feat/thing']],
  ])('reads the destination of: %s', (command, expected) => {
    expect(pushTargets(command)?.targets).toEqual(expected);
  });

  it('does not read a push out of a quoted string', () => {
    // Same reason every other matcher goes through commandSkeleton.
    expect(pushTargets('echo "git push origin HEAD:main"')).toBeNull();
  });
});

/**
 * The quoting regressions, kept together because they share one cause: an earlier version blanked
 * every quoted span, which destroyed information three of these matchers need. Quoted text is data
 * to a verb matcher and a value to a selector, a refspec or a redirect target, so `commandSkeleton`
 * takes a mode and each caller picks. Three of the five below were fail-open holes in the guards
 * around `main`.
 */
describe('quoted arguments', () => {
  it('reads a quoted PR selector as written', () => {
    // Blanked, this yielded selector: [] — so protect-merge checked the current branch's pull
    // request instead of the named one, and a merge into main was approved against a different PR.
    // protect-merge refuses the `$` in it as a selector it cannot evaluate.
    expect(mergeTargets('gh pr merge "$PR" --merge')).toEqual([{ selector: ['$PR'] }]);
  });

  it('reads a quoted refspec', () => {
    // Blanked, this parsed as a bare push, which skips the refspec check entirely.
    expect(pushTargets('git push origin "HEAD:main"')).toMatchObject({
      targets: ['main'],
      bare: false,
    });
  });

  it('does not let a long flag eat the remote', () => {
    // Git's long push options take their value with `=`, so treating them as separate-word flags
    // consumed `origin`, left no refspec, and reported a bare push.
    expect(pushTargets('git push --signed origin main')?.targets).toEqual(['main']);
    expect(pushTargets('git push --force-with-lease=main origin main')?.targets).toEqual(['main']);
    expect(pushTargets('git push --recurse-submodules=check origin main')?.targets).toEqual([
      'main',
    ]);
    // The one short flag that genuinely takes the next word still does.
    expect(pushTargets('git push -o ci.skip origin HEAD:staging')?.targets).toEqual(['staging']);
  });

  it('reads a quoted redirect target as a path', () => {
    // The target is a value, so dropping its quotes hid the /tmp path and called a read a write.
    expect(writesToWorktree('git log > "/tmp/a.txt" && echo done')).toBe(false);
    expect(writesToWorktree('git log > /tmp/a.txt && echo done')).toBe(false);
    // Still a write when the quoted target is in the repository.
    expect(writesToWorktree('echo x > "src/x.ts"')).toBe(true);
  });

  it('does not read a write verb out of quoted data', () => {
    // A verb inside quotes is something being searched for or written about, not run.
    expect(writesToWorktree('grep -rn "rm -rf" docs/')).toBe(false);
    expect(writesToWorktree('echo "see the mv section"')).toBe(false);
    expect(writesToWorktree('grep -rn "install" package.json')).toBe(false);
    // And the real verb is still caught when it is not quoted.
    expect(writesToWorktree('rm -rf build')).toBe(true);
  });

  it('still defuses a redirect that sits inside quotes', () => {
    // The other direction of the same trade: keeping quoted text must not turn a comparison into a
    // redirect.
    expect(writesToWorktree("awk '$1 > 2' data.txt")).toBe(false);
    expect(writesToWorktree('grep -n ">" src/app/page.tsx')).toBe(false);
  });
});

describe('line continuations', () => {
  it('joins a command split across lines with a backslash', () => {
    // A trailing backslash removes the newline, so the words either side are one argument list.
    // Left in, the backslash became a token and the newline still read as a separator.
    expect(commandSkeleton('git push origin \\\nmain')).toBe('git push origin main');
  });

  it('does not let a continuation hide a push target', () => {
    // Both shapes were fail-open: the refspec parsed as `\` and was not a protected branch, and the
    // second form lost `origin` so it looked like a bare push, which skips the refspec check.
    expect(pushTargets('git push origin \\\nmain')?.targets).toEqual(['main']);
    expect(pushTargets('git push \\\norigin main')?.targets).toEqual(['main']);
    expect(pushTargets('git push \\\norigin \\\nstaging')?.targets).toEqual(['staging']);
  });

  it('does not let a continuation hide a merge', () => {
    expect(mergeTargets('gh pr \\\nmerge 42')).toEqual([{ selector: ['42'] }]);
  });

  it('leaves a backslash that is not at end of line alone', () => {
    // An escape inside a command is not a continuation.
    expect(pushTargets('git push origin main')?.targets).toEqual(['main']);
    expect(writesToWorktree('grep -rn "a\\\\b" src/')).toBe(false);
  });

  it('treats a continuation inside double quotes as one string', () => {
    expect(commandSkeleton('echo "one \\\ntwo"')).not.toContain('\n');
  });
});

describe('whole-branch pushes', () => {
  it('refuses a push of every branch', () => {
    // These carry no refspec, so they read as a bare push and sent the hook to look at the current
    // branch and its upstream — both unprotected on an ordinary feature branch, while the push
    // itself wrote main and staging.
    expect(pushTargets('git push --all origin')?.everyBranch).toBe(true);
    expect(pushTargets('git push --mirror origin')?.everyBranch).toBe(true);
  });

  it('does not treat a tags-only push as a branch push', () => {
    // `--tags` with no refspec writes tags and no branch, so there is nothing here to protect.
    // Counting it as a bare push refused it whenever the branch upstream was protected.
    expect(pushTargets('git push --tags origin')).toMatchObject({ targets: [], bare: false });
    // `--follow-tags` is not tags-only: it pushes what a bare push would, plus the tags.
    expect(pushTargets('git push --follow-tags origin')?.bare).toBe(true);
  });
});

describe('the scratch directory', () => {
  /**
   * `tmp/` is the conventional gitignored scratch directory, where a dev server keeps its log and
   * marker files. Leaving it off the safe list refused starting one on a protected branch, and the
   * refusal advised making a feature branch, which is neither the problem nor the fix.
   */
  it.each([
    ['mkdir -p tmp'],
    ['touch tmp/.dev-server-wanted'],
    ['rm -f tmp/.dev-server-wanted'],
    ['pnpm dev --port 3000 > tmp/localhost-3000.log 2>&1'],
    ['mkdir -p tmp && touch tmp/.dev-server-wanted'],
    ['echo x > ./tmp/a.log'],
  ])('is not a worktree write: %s', (command) => {
    expect(writesToWorktree(command)).toBe(false);
  });

  it('judges each segment separately', () => {
    // The exemption is per command segment, so one scratch write does not licence a tracked one
    // beside it.
    expect(writesToWorktree('mkdir -p tmp && rm src/x.ts')).toBe(true);
    expect(writesToWorktree('mv tmp/a src/b')).toBe(true);
    expect(writesToWorktree('cp tmp/a public/b')).toBe(true);
  });

  it('refuses a path verb whose operands it cannot see', () => {
    // `xargs rm` takes its paths on stdin, so there is nothing to judge and guessing would be the
    // wrong direction for this hook.
    expect(writesToWorktree('find . -name x | xargs rm')).toBe(true);
  });

  it('still refuses an in-place edit of a scratch path', () => {
    // sed -i names the file it rewrites, and a rewrite is not confined by where it points.
    expect(writesToWorktree('sed -i "" s/a/b/ tmp/a.log')).toBe(true);
  });
});

describe('force pushes', () => {
  it.each([
    ['git push origin HEAD --force'],
    ['git push --force origin HEAD'],
    ['git push origin HEAD -f'],
    ['git push -uf origin HEAD'],
    ['git push --force-with-lease origin HEAD'],
    ['git push --force-with-lease=main origin HEAD'],
  ])('is detected: %s', (command) => {
    // The deny rules in settings.json are prefix rules, so only a leading flag was covered and
    // `git push origin HEAD --force` satisfied both of them.
    expect(pushTargets(command)?.force).toBe(true);
  });

  it.each([['git push -u origin HEAD'], ['git push --filter=blob:none origin HEAD'], ['git push']])(
    'is not a force push: %s',
    (command) => {
      expect(pushTargets(command)?.force).toBe(false);
    }
  );
});

describe('git global options and unresolved targets', () => {
  it('sees a subcommand behind a global option', () => {
    // `git -C <path>` and `git -c <name>=<value>` sit between `git` and the subcommand. A pattern
    // demanding they be adjacent missed a direct push to main, and missed every
    // `git -c user.name=x commit` — which is the form this repository's own commits are made with,
    // so the branch guard was blind to exactly the command it was written for.
    expect(pushTargets('git -C /repo push origin main')?.targets).toEqual(['main']);
    expect(pushTargets('git -c user.name=x push origin main')?.targets).toEqual(['main']);
    expect(pushTargets('git --no-pager push origin main')?.targets).toEqual(['main']);
    expect(writesToWorktree('git -c user.name=x commit -m y')).toBe(true);
    expect(writesToWorktree('git -C /repo commit -m x')).toBe(true);
    expect(writesToWorktree('git -C /repo checkout -- src/')).toBe(true);
  });

  it('does not mistake a read for a write behind a global option', () => {
    expect(writesToWorktree('git -C /repo log --oneline')).toBe(false);
    expect(writesToWorktree('git -C /repo status')).toBe(false);
  });

  it('reads the refspec when --repo names the remote', () => {
    // With `--repo` the remote is in the flag, so the first operand is already a refspec. Read as a
    // remote, it left no refspec at all and reported a bare push.
    expect(pushTargets('git push --repo=origin main')?.targets).toEqual(['main']);
    expect(pushTargets('git push --repo=origin main')?.bare).toBe(false);
  });

  it('marks a target it cannot evaluate rather than calling it safe', () => {
    // `git push origin $BRANCH` compared the literal string against the protected set, found no
    // match, and allowed it. protect-merge has had this concept since its own version of the bug.
    expect(pushTargets('git push origin $BRANCH')?.unresolved).toBe(true);
    expect(pushTargets('git push origin `cat b`')?.unresolved).toBe(true);
    expect(pushTargets('git push origin main')?.unresolved).toBe(false);
    expect(pushTargets('git push -u origin HEAD')?.unresolved).toBe(false);
  });

  it('marks a brace expansion unresolved, since bash turns it into more refspecs', () => {
    // `git push origin {main,feat}` read as one refspec named `{main,feat}`, which is not
    // protected, and bash then pushed `main` and `feat`.
    expect(pushTargets('git push origin {main,feat}')?.unresolved).toBe(true);
    expect(pushTargets('git push origin HEAD:{main,feat}')?.unresolved).toBe(true);
    expect(pushTargets('git push origin feat/{a,b}')?.unresolved).toBe(true);
    expect(pushTargets('git push origin feat/a')?.unresolved).toBe(false);
    // Braces on the source side are git's reflog syntax, not an expansion of the destination.
    expect(pushTargets('git push origin HEAD@{1}:feat/x')?.unresolved).toBe(false);
    expect(pushTargets('git push origin HEAD@{1}:feat/x')?.targets).toEqual(['feat/x']);
    expect(pushTargets('git push origin HEAD@{1}:main')?.targets).toEqual(['main']);
  });
});

describe('more than one invocation in a call', () => {
  it('finds every push, not the first', () => {
    // Judged by the first alone, `git push origin feat/x && git push origin main` looked harmless
    // and the second push reached no guard at all.
    expect(pushTargets('git push origin feat/x && git push origin main')?.targets).toEqual([
      'feat/x',
      'main',
    ]);
  });

  it('folds a force flag from any invocation', () => {
    // A `--force` on a later push was reported as no force at all.
    expect(pushTargets('git push origin feat/x; git push origin main --force')?.force).toBe(true);
  });

  it('finds every merge, not the first', () => {
    expect(mergeTargets('gh pr merge 7 && gh pr merge 9')).toEqual([
      { selector: ['7'] },
      { selector: ['9'] },
    ]);
  });

  it('finds a merge that follows a create', () => {
    expect(
      prInvocations('gh pr create --fill && gh pr merge 42', ['create', 'merge']).map(
        (i) => i.subcommand
      )
    ).toEqual(['create', 'merge']);
  });

  it('still finds nothing in a quoted mention', () => {
    expect(mergeTargets('echo "gh pr merge 1 && gh pr merge 2"')).toEqual([]);
  });
});

describe('command positions a separator alone does not cover', () => {
  /**
   * The anchor required a separator immediately before the binary, so a shell keyword or a wrapper
   * in between made the invocation invisible and every guard built on it was bypassed.
   */
  it.each([
    ['if true; then git push origin main; fi'],
    ['time git push origin main'],
    ['nohup git push origin main'],
    ['! git push origin main'],
  ])('sees the push in: %s', (command) => {
    expect(pushTargets(command)?.targets).toEqual(['main']);
  });

  it('sees the merge in a conditional', () => {
    expect(mergeTargets('if true; then gh pr merge 1 --merge; fi')).toEqual([{ selector: ['1'] }]);
  });

  it('sees a write verb in a conditional', () => {
    expect(writesToWorktree('if true; then rm src/x.ts; fi')).toBe(true);
    expect(writesToWorktree('if true; then mkdir -p tmp; fi')).toBe(false);
  });
});

describe('quoted operands of a write verb', () => {
  it('reads a quoted scratch path', () => {
    // Operands were read from the quote-dropped skeleton, so a quoted target vanished, the
    // "no operands" guard fired, and the documented /localhost commands were called repository
    // writes — the regression the SAFE_TARGET comment claims to have fixed.
    expect(writesToWorktree('touch "tmp/.dev-server-wanted"')).toBe(false);
    expect(writesToWorktree('rm -f "tmp/.dev-server-wanted"')).toBe(false);
    expect(writesToWorktree('mkdir -p "tmp"')).toBe(false);
  });

  it('still reads a quoted tracked path as a write', () => {
    expect(writesToWorktree('rm "src/x.ts"')).toBe(true);
    expect(writesToWorktree('touch "src/app/page.tsx"')).toBe(true);
  });

  it('refuses an operand it cannot resolve', () => {
    // A substitution cannot be resolved to a path, so it is not known to be scratch. Refusing is
    // the safe direction; /localhost cds first and names the path plainly.
    expect(writesToWorktree('rm -f "$(git rev-parse --show-toplevel)/tmp/x"')).toBe(true);
  });

  it('allows a repo-relative scratch path', () => {
    expect(
      writesToWorktree(
        'cd "$(cd "$(git rev-parse --show-toplevel)" && pwd -P)" && rm -f tmp/.dev-server-wanted'
      )
    ).toBe(false);
  });
});

describe('prDetails and prFiles', () => {
  it('reports a failed lookup rather than throwing, and reads one REST endpoint', () => {
    const thrown = prDetails(['5'], {
      exec: () => {
        throw new Error('no such pull request');
      },
    });
    expect(thrown.ok).toBe(false);

    const calls = [];
    const parsed = prDetails(['5'], {
      cwd: '/somewhere',
      exec: (file, args) => {
        calls.push([file, ...args]);
        return '{"baseRefName":"staging","number":5}';
      },
    });
    expect(parsed.ok && parsed.pr.baseRefName).toBe('staging');
    expect(calls).toEqual([
      [
        'gh',
        'api',
        'repos/{owner}/{repo}/pulls/5',
        '--jq',
        '{baseRefName: .base.ref, number, url: .html_url}',
      ],
    ]);
  });

  it('reads a URL, a branch and the current branch', () => {
    const endpoint = (selector) => {
      let seen = '';
      prDetails(selector, {
        exec: (_file, args) => {
          seen = args[1] ?? '';
          return '{"baseRefName":"main","number":7}';
        },
      });
      return seen;
    };
    expect(endpoint(['https://github.com/o/r/pull/7'])).toBe('repos/o/r/pulls/7');
    expect(endpoint(['#7'])).toBe('repos/{owner}/{repo}/pulls/7');
    expect(endpoint(['feature/x'])).toBe(
      'repos/{owner}/{repo}/pulls?head={owner}:feature%2Fx&state=open'
    );
    expect(endpoint([])).toBe('repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=open');
    // A branch with no open pull request prints nothing, which is unreadable.
    expect(prDetails([], { exec: () => '' }).ok).toBe(false);
    expect(prDetails(['5'], { exec: () => '{"number":5}' }).ok).toBe(false);
  });

  it('pages the files endpoint, from the repository the pull request names', () => {
    const calls = [];
    const exec = (file, args) => {
      calls.push([file, ...args]);
      return 'a.ts\nb.ts\n';
    };
    expect(prFiles({ number: 5 }, { exec })).toEqual({ ok: true, paths: ['a.ts', 'b.ts'] });
    expect(calls[0]).toEqual([
      'gh',
      'api',
      '--paginate',
      'repos/{owner}/{repo}/pulls/5/files?per_page=100',
      '--jq',
      '.[] | .filename, (.previous_filename // empty)',
    ]);
    prFiles({ number: 5, url: 'https://github.com/o/r/pull/5' }, { exec });
    expect(calls[1]?.[3]).toBe('repos/o/r/pulls/5/files?per_page=100');
    const failed = prFiles(
      { number: 5 },
      {
        exec: () => {
          throw new Error('diff too large');
        },
      }
    );
    expect(failed.ok).toBe(false);
  });
});

describe('mergesIn', () => {
  const mcp = (input) =>
    mergesIn({ tool_name: 'mcp__github__merge_pull_request', tool_input: input });

  it('reads the MCP merge tool by URL, under any server name, or as unreadable', () => {
    const url = [{ selector: ['https://github.com/o/r/pull/12'] }];
    expect(mcp({ owner: 'o', repo: 'r', pull_number: 12 })).toEqual(url);
    expect(mcp({ owner: 'o', repo: 'r', pull_number: '12' })).toEqual(url);
    expect(mcp({ owner: 'o', repo: 'r', pullNumber: 12 })).toEqual(url);
    expect(
      mergesIn({
        tool_name: 'mcp__github-official__merge_pull_request',
        tool_input: { owner: 'o', repo: 'r', pullNumber: 12 },
      })
    ).toEqual(url);
    expect(
      mergesIn({ tool_name: 'mcp__github__get_pull_request', tool_input: { pullNumber: 12 } })
    ).toEqual([]);
    expect(mcp({ owner: 'o', pull_number: 12 })).toEqual([{ selector: null }]);
    expect(mcp({ owner: 'o/x', repo: 'r', pull_number: 12 })).toEqual([{ selector: null }]);
  });

  it('reads a Bash call as its command', () => {
    expect(mergesIn({ tool_name: 'Bash', tool_input: { command: 'gh pr merge 5' } })).toEqual([
      { selector: ['5'] },
    ]);
    expect(mergesIn({ tool_name: 'Bash', tool_input: { command: 'gh pr view 5' } })).toEqual([]);
  });
});

const MERGES = [
  ['gh pr merge 5 --merge --delete-branch', ['5']],
  ['sh -c "gh pr merge 5"', ['5']],
  ["bash -lc 'cd x && gh pr merge 5'", ['5']],
  ['command gh pr merge 5', ['5']],
  ['/opt/homebrew/bin/gh pr merge 5', ['5']],
  ['eval "gh pr merge 5"', ['5']],
  ['env FOO=1 nohup time gh pr merge 5', ['5']],
  ['sudo -u me gh pr merge 5', ['5']],
  ['echo $(gh pr merge 5)', ['5']],
  ['out="$(gh pr merge 5)"', ['5']],
  ['out="`gh pr merge 5`"', ['5']],
  ['timeout 600 gh pr merge 5', ['5']],
  ['env -S "gh pr merge 5"', ['5']],
  ['env --split-string="gh pr merge 5"', ['5']],
  ['timeout -k 5 600 gh pr merge 5', ['5']],
  ['bash -o pipefail -c "gh pr merge 5"', ['5']],
  ['gh pr merge --subject "a b" 5 --merge', ['5']],
  ['gh pr merge 5 --merge --match-head-commit abc123', ['5']],
  ['gh pr merge 5 --merge 2>&1 | tail -3', ['5']],
  ['gh pr merge', []],
  ['gh api -X PUT repos/{owner}/{repo}/pulls/5/merge', ['5']],
  ['gh api -XPUT repos/{owner}/{repo}/pulls/5/merge', ['5']],
  ['gh api -X PUT repos/:owner/:repo/pulls/5/merge', ['5']],
  ['gh pr merge -dt 7 5', ['5']],
  ['gh pr merge -Rother/repo 5', null],
  ['gh pr -R other/repo merge 5', null],
  ['export GH_REPO=other/repo; gh pr merge 5', null],
  ['GH_REPO=other/repo bash -c "gh pr merge 5"', null],
  [
    'gh api -X PUT https://api.github.com/repos/o/r/pulls/5/merge',
    ['https://github.com/o/r/pull/5'],
  ],
  ["bash <<'EOF'\ngh pr merge 5\nEOF", ['5']],
  ['bash <<< "gh pr merge 5"', ['5']],
  ['git commit -m "the <<EOF form"\ngh pr merge 5', ['5']],
  ['echo 5 | xargs -n1 gh pr merge', null],
  ['git commit -m "$(cat <<\'EOF\'\nfix: read the :-( case\nEOF\n)" && gh pr merge 5', ['5']],
  ['cat <<EOF | bash\ngh pr merge 5\nEOF', ['5']],
  ["echo 'gh pr merge 5' | sh", ['5']],
  ['false || gh pr merge 5', ['5']],
  ['x=$((1<<2))\ngh pr merge 5', ['5']],
  ['function f { gh pr merge 5; }; f', ['5']],
  ["bash -c $'echo hi\\ngh pr merge 5'", ['5']],
  ['gh api -X PUT repos/{owner}/{repo}/pulls/5/ccr/auto_merge', ['5']],
  ['timeout --kill-after 5 600 gh pr merge 5', ['5']],
  ['timeout --signal KILL 600 gh pr merge 5', ['5']],
  ['gh api -iX PUT repos/{owner}/{repo}/pulls/5/merge', ['5']],
  ['gh pr --repo=other/repo merge 5', null],
  ['export GH_REPO=other/repo && bash -c "gh pr merge 5"', null],
  ['cat <<< hello\ngh pr merge 5', ['5']],
  ['sh -s <<EOF\ngh pr merge 5\nEOF', ['5']],
  ['export GH_REPO=o/r; out="$(gh pr merge 5)"', null],
  ['x="$(echo "(")"; gh pr merge 5', ['5']],
  ["echo $'a\\'b'; gh pr merge 5", ['5']],
  ['(( n <<= 1 ))\ngh pr merge 5', ['5']],
  ['((gh pr merge 5) )', ['5']],
  ['echo $(( $(gh pr merge 5) + 0 ))', ['5']],
  ['echo $(( `gh pr merge 5` + 0 ))', ['5']],
  ['function f() { gh pr merge 5; }', ['5']],
  ['echo $((gh pr merge 5) )', ['5']],
  ["gh api -X PUT 'repos/{owner}/{repo}/pulls/5/merge?merge_method=merge'", ['5']],
  ['env -P /usr/bin gh pr merge 5', ['5']],
  ['env --chdir /tmp gh pr merge 5', ['5']],
  ['gh api --method PUT /repos/o/r/pulls/5/merge', ['https://github.com/o/r/pull/5']],
  ['gh pr merge 5 --repo other/repo', null],
  ['gh pr merge 5 -R other/repo', null],
  ['GH_REPO=other/repo gh pr merge 5', null],
  ['GH_REPO=other/repo eval "gh pr merge 5"', null],
  ['GH_REPO=other/repo env -S "gh pr merge 5"', null],
  ['gh api -X POST repos/{owner}/{repo}/pulls/5/ccr/auto_merge', ['5']],
  ['gh api repos/{owner}/{repo}/pulls/5/ccr/auto_merge -f merge_method=merge', ['5']],
  [
    'gh api --method put https://api.github.com/repos/o/r/pulls/5/ccr/auto_merge',
    ['https://github.com/o/r/pull/5'],
  ],
];

const PROSE = [
  'git commit -m "explain gh pr merge 5"',
  'echo gh pr merge 5',
  "cat > notes.md <<'EOF'\ngh pr merge 5\nEOF",
  'grep -rn "gh pr merge" .claude/',
  'gh pr view 5',
  'gh api repos/{owner}/{repo}/pulls/5/merge',
  'gh api -X GET repos/{owner}/{repo}/pulls/5/merge',
  'echo "built at $(date)"',
  'command -v gh',
  "echo 'gh pr merge 5' | grep merge",
  'gh api -X DELETE repos/{owner}/{repo}/pulls/5/ccr/auto_merge',
  'gh api repos/{owner}/{repo}/pulls/5',
  'gh api graphql -f query="{ viewer { login } }"',
  'git commit -m "$(cat <<\'EOF\'\nexplain gh pr merge 5 :-(\nEOF\n)"',
  'export GH_REPO=other/repo; gh pr view 5',
  'gh api https://api.github.com/repos/o/r/pulls/5/merge',
  'gh api repos/{owner}/{repo}/pulls/5/ccr/auto_merge',
];

/** Landing on `main` with no pull request. A base that is not on the line is unreadable. */
const DIRECT = [
  ['gh api repos/{owner}/{repo}/merges -f base=main -f head=staging', 'main'],
  ['gh api -X POST repos/o/r/merges -f head=x -F base=refs/heads/main', 'main'],
  ['gh api -X PATCH repos/{owner}/{repo}/git/refs/heads/main -f sha=abc -F force=true', 'main'],
  ['gh api -X DELETE https://api.github.com/repos/o/r/git/refs/heads/main', 'main'],
  ['gh api repos/o/r/merges --input body.json', null],
  ['gh api repos/o/r/merges -f base="$base" -f head=x', null],
  ['gh api -X PATCH repos/{owner}/{repo}/git/refs/heads/{branch} -f sha=abc', null],
  ['gh api https://api.github.com/repos/o/r/merges --field=base=main -f head=x', 'main'],
  ['gh api repos/{owner}/{repo}/git/refs/heads/main -f sha=abc', 'main'],
  ['gh api -X PUT repos/o/r/git/refs/heads/main -f sha=abc', 'main'],
  ['gh api -X DELETE /repos/o/r/git/refs/heads/main/', 'main'],
  ['gh api repos/o/r/merges -F base=@base.txt -f head=x', null],
  ['gh api repos/o/r/merges -f base=`echo main` -f head=x', null],
  ['gh api repos/o/r/merges -f base="`echo main`" -f head=x', null],
];

const NOT_DIRECT = [
  'gh api repos/{owner}/{repo}/git/refs/heads/main',
  'gh api -X DELETE repos/{owner}/{repo}/git/refs/heads/feature',
  'gh api repos/o/r/merges -f base=staging -f head=feature',
  'gh api -X GET repos/o/r/git/refs/heads/main',
  'gh api -X PATCH repos/o/r/git/refs/heads/main-old -f sha=abc',
];

/** Writes to the production branch through the REST API, other than a merge. */
const BRANCH_WRITES = [
  [
    'gh api -X PUT repos/{owner}/{repo}/contents/a.md -f message=x -f content=eA== -f branch=main',
    'main',
  ],
  ['gh api -X PUT repos/o/r/contents/a.md -f message=x -f content=eA==', null],
  [
    'gh api -X DELETE repos/o/r/contents/a.md -f message=x -f sha=abc -f branch=refs/heads/main',
    'main',
  ],
  ['gh api -X PUT repos/o/r/contents/a.md --input body.json', null],
  ['gh api -X PUT repos/o/r/contents/a.md -f message=x -F branch={branch}', null],
  ['gh api -X PUT repos/o/r/contents/a.md -f message=x -f branch=feat/x', 'feat/x'],
  ['gh api repos/o/r/git/refs -f ref=refs/heads/main -f sha=abc', 'main'],
  ['gh api repos/o/r/git/refs -F ref=@ref.txt -f sha=abc', null],
  ['gh api repos/o/r/merge-upstream -f branch=main', 'main'],
  ['gh api -X DELETE repos/o/r/branches/main/protection', 'main'],
  ['gh api repos/o/r/branches/main/rename -f new_name=old', 'main'],
  ['gh api -X PATCH repos/o/r/git/refs/heads/ma%69n -f sha=abc', 'main'],
  ['gh api -X DELETE repos/o/r/branches/$b/protection', null],
  ['gh api -X DELETE repositories/42/branches/main/protection', 'main'],
  ['gh api repositories/42/merges -f base=main -f head=x', 'main'],
];

const GRAPHQL = [
  [
    'gh api graphql -f query="mutation { mergePullRequest(input: {}) { clientMutationId } }"',
    ['mergePullRequest'],
  ],
  [
    'gh api graphql -f query=\'mutation { m: mergeBranch(input: {base: "main", head: "x"}) { clientMutationId } }\'',
    ['mergeBranch'],
  ],
  [
    'gh api graphql -f query=\'mutation { updateRef(input: {refId: "R", oid: "abc"}) { clientMutationId } }\'',
    ['updateRef'],
  ],
  [
    "gh api graphql -f query='mutation { createCommitOnBranch(input: {}) { commit { oid } } enablePullRequestAutoMerge(input: {}) { clientMutationId } }'",
    ['createCommitOnBranch', 'enablePullRequestAutoMerge'],
  ],
  [
    'gh api graphql -f query=\'# merge\nmutation { addComment(input: {subjectId: "X", body: "{ }"}) { clientMutationId } }\'',
    ['addComment'],
  ],
  [
    'gh api https://api.github.com/graphql -f query="mutation { updateRef(input: {}) { clientMutationId } }"',
    ['updateRef'],
  ],
];

const GRAPHQL_UNREADABLE = [
  'gh api graphql -f query=\'mutation($id: ID!) { m: mergeBranch(input: {repositoryId: $id, base: "main", head: "x"}) { clientMutationId } }\'',
  'gh api graphql -F query=@mutation.graphql',
  'gh api graphql --input body.json',
  'gh api graphql -f query="$Q"',
  "gh api graphql -f query='mutation { ...F } fragment F on Mutation { mergeBranch(input: {}) { clientMutationId } }'",
  "gh api graphql -f query='mutation { mergeBranch(input: {}) { clientMutationId }'",
  "gh api graphql -f query='mutation($b: String!) { updatePullRequest(input: {baseRefName: $b}) { clientMutationId } }' -f b=main",
  "gh api graphql -f query='mutation { }'",
  "gh api graphql -f query='mutation { @skip(if: true) }'",
];

describe('every spelling of a merge', () => {
  it('reads a merge by repository id as unreadable', () => {
    expect(mergeTargets('gh api -X PUT repositories/42/pulls/5/merge')).toEqual([
      { selector: null },
    ]);
    expect(mergeTargets('gh api repositories/42/pulls/5/merge')).toEqual([]);
  });

  it.each(MERGES)('reads %s', (command, selector) => {
    expect(mergeTargets(command)).toEqual([{ selector }]);
  });

  it.each(BRANCH_WRITES)('reads the branch a REST write lands on in %s', (command, branch) => {
    expect(mergeTargets(command)).toEqual([{ branch }]);
  });

  it.each(GRAPHQL)('reads the mutations in %s', (command, fields) => {
    expect(mergeTargets(command)[0].mutation).toEqual(fields);
  });

  it.each(GRAPHQL_UNREADABLE.map((c) => [c]))('marks %s unreadable', (command) => {
    expect(mergeTargets(command)[0].mutation).toBeNull();
  });

  it('reads no mutation in a GraphQL query, and keeps what a mutation names', () => {
    expect(
      mergeTargets("gh api graphql -f query='query($n: Int!) { viewer { login } }' -F n=5")
    ).toEqual([]);
    expect(mergeTargets("gh api graphql -f query='{ viewer { login } }'")).toEqual([]);
    const [named] = mergeTargets(
      `gh api graphql -f query='mutation { updatePullRequest(input: {baseRefName: "main"}) { clientMutationId } }'`
    );
    expect(named.writes).toContain('main');
  });

  it('lists what any other REST write names, so the hook can refuse one naming production', () => {
    expect(mergeTargets('gh api repos/o/r/pulls/5 -X PATCH -f base=main')).toEqual([
      { writes: ['pulls', '5', 'main'] },
    ]);
    expect(mergeTargets('gh api repos/o/r/git/refs -f ref=refs/tags/v1 -f sha=abc')).toEqual([
      { writes: ['git', 'refs', 'refs/tags/v1', 'abc'] },
    ]);
  });

  it.each(PROSE.map((command) => [command]))('reads no merge in %s', (command) => {
    expect(mergeTargets(command)).toEqual([]);
  });

  it.each(DIRECT)('reads a write with no pull request in %s', (command, branch) => {
    expect(mergeTargets(command)).toEqual([{ branch }]);
  });

  // A write to another branch's ref names that branch, and the hook lets it pass; a read is no
  // write at all. Neither is a write into `main` or one whose branch is unreadable.
  it.each(NOT_DIRECT.map((command) => [command]))('reads no write into main in %s', (command) => {
    const into = mergeTargets(command).filter((m) => m.branch === 'main' || m.branch === null);
    expect(into).toEqual([]);
  });
});

describe('prCalls', () => {
  const base = (command) => {
    const [call] = prCalls(command, ['create']);
    return call?.pairs.filter(([name]) => name === '--base' || name === '-B').at(-1)?.[1];
  };

  it('reads --base in every spelling gh takes', () => {
    for (const command of [
      'gh pr create -B main -H staging',
      'gh pr create --base "main"',
      'gh pr create --base=main',
      "gh pr create --fill --base 'main'",
    ]) {
      expect(base(command), command).toBe('main');
    }
  });

  it('does not read a flag out of a quoted body', () => {
    expect(base('gh pr create --body "run gh pr create --base main" --fill')).toBeUndefined();
  });

  it('keeps the selector and the inline environment of each call', () => {
    expect(prCalls('gh pr merge -m 57', ['merge'])[0]?.positionals).toEqual(['57']);
    expect(prCalls('gh pr -R o/r ready 9', ['ready'])[0]?.positionals).toEqual(['9']);
    const [call] = prCalls('ALLOW_UNDECIDED_MERGE=1 gh pr create --fill', ['create']);
    expect(call?.env.ALLOW_UNDECIDED_MERGE).toBe('1');
  });

  it('follows a cd earlier in the command', () => {
    const dir = (command) => prCalls(command, ['create']).map((call) => call.dir);
    expect(dir('gh pr create --fill')).toEqual([null]);
    expect(dir('cd ../other && gh pr create --fill')).toEqual(['../other']);
    expect(dir('cd a; cd b && gh pr create')).toEqual(['a/b']);
    expect(dir('cd a && cd /abs && gh pr create')).toEqual(['/abs']);
    expect(dir('cd -P a && gh pr create')).toEqual(['a']);
    // A cd this cannot follow goes back to the call's own directory.
    for (const cd of ['cd', 'cd -', 'cd ~/x', 'cd $DIR', 'cd a && cd']) {
      expect(dir(`${cd} && gh pr create`), cd).toEqual([null]);
    }
  });
});

describe('chained merges', () => {
  it('finds every merge in a chained command', () => {
    expect(mergeTargets('gh pr merge 5 && gh pr merge 6')).toEqual([
      { selector: ['5'] },
      { selector: ['6'] },
    ]);
  });
});

/**
 * Both directions matter for the branch guard. A miss is how it gets walked past; a false
 * positive blocks reading a file on a protected branch, and a hook that blocks ordinary work gets
 * bypassed out of habit rather than on purpose.
 */
const READS = [
  'git status',
  'git log --oneline -3 | cat',
  'git diff origin/staging...HEAD',
  'pnpm typecheck && pnpm lint',
  'pnpm build 2>&1 | tail -3',
  'grep -rn "canon" docs/',
  'cat docs/canon/content.md',
  'wc -l docs/canon/*.md',
  'gh pr checks 31',
  'node scripts/report.mjs',
  'sed -n "1,40p" CLAUDE.md',
  'ls -l .claude/hooks',
  'echo hi > /tmp/note.txt',
  'pnpm test > /dev/null 2>&1',
  'cat x 2>&1 | head',
  '',
];

const WRITES = [
  "cat > docs/canon/content.md <<'EOF'",
  'echo x >> CLAUDE.md',
  "python3 - <<'PY'",
  'python3 -c "import pathlib"',
  "node -e \"require('fs').writeFileSync('a','b')\"",
  "sed -i '' 's/a/b/' CLAUDE.md",
  "perl -pi -e 's/a/b/' CLAUDE.md",
  'git commit -m "x"',
  'git mv a b',
  'rm -rf docs/decisions',
  'mv a b',
  'git apply patch.diff',
  'git checkout -- CLAUDE.md',
  'tee CLAUDE.md',
];

describe('writesToWorktree, both directions', () => {
  it.each(READS)('reads only: %s', (command) => {
    expect(writesToWorktree(command)).toBe(false);
  });
  it.each(WRITES)('writes: %s', (command) => {
    expect(writesToWorktree(command)).toBe(true);
  });
});
