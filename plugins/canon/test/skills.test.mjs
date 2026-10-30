/**
 * The rules in a skill that decide whether code merges. A skill is prose, so these
 * pin the text: rewording it is fine, and dropping the rule fails here.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, describe, expect, it } from './helpers.mjs';

const skill = (name) => readFileSync(join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');

describe('staging merges only on a success for the head commit', () => {
  const staging = skill('staging');

  it('reads every check run on the head SHA, not one that happens to have passed', () => {
    expect(staging).toContain('sha=$(gh api "repos/{owner}/{repo}/pulls/<number>" --jq .head.sha)');
    expect(staging).toContain('commits/$sha/check-runs');
    // A failing call prints nothing, which must not read as nothing having run.
    expect(staging).toContain(
      '--jq ".check_runs[] | $buckets") \\\n  && if [ -z "$runs" ]; then echo none; else sort <<<"$runs" | uniq -c; fi'
    );
    expect(staging).toContain(
      'if .status != "completed" or .conclusion == "action_required" then "pending"'
    );
    expect(staging).toContain('elif .conclusion == "success" then "success"');
    // A run cancelled by a later one on the same head is superseded, not failing.
    expect(staging).toContain(
      'elif (.conclusion | IN("skipped", "neutral", "cancelled", "stale")) then "ignored"'
    );
    expect(staging).toContain('else "failing" end');
    // A query that only counts successes passes on one quick check beside a failing one.
    expect(staging).not.toContain('select(.conclusion == "success")] | length');
  });

  it('passes only on a success with nothing pending or failing', () => {
    expect(staging).toMatch(/Only a success on the head SHA is a pass/);
    expect(staging).toMatch(/missing run and a run that\s+ended `skipped` or `neutral` are not/);
    expect(staging).toMatch(
      /passes only when at least one is `success`, none is `pending` and none is `failing`/
    );
  });

  it('merges on the head CI verified', () => {
    expect(staging).toContain(
      'gh api -X PUT "repos/{owner}/{repo}/pulls/<number>/merge" \\\n  -f merge_method=merge -f sha="$sha"'
    );
    expect(staging).toMatch(/run step 6's check-run query on it once more first/);
  });
});

describe('staging starts CI on a head nothing has run on, once', () => {
  const staging = skill('staging');

  it("reads the configured workflow's runs on the head SHA", () => {
    expect(staging).toContain(
      'gh api --paginate "repos/{owner}/{repo}/actions/workflows/<workflow>/runs?head_sha=$sha&per_page=100"'
    );
    expect(staging).toContain(
      '--jq ".workflow_runs[] | $buckets") \\\n  && if [ -z "$runs" ]; then echo none; else sort <<<"$runs" | uniq -c; fi'
    );
    expect(staging).toMatch(/A query that fails is not an empty answer/);
  });

  it('decides on dispatching before it watches the checks', () => {
    expect(staging.indexOf('/dispatches')).toBeLessThan(
      staging.indexOf('**Then wait for the checks**')
    );
    expect(staging.indexOf('sha=$(gh api')).toBeLessThan(staging.indexOf('head_sha=$sha'));
  });

  it("dispatches on the pull request's branch, with the base input when there is one", () => {
    expect(staging).toContain(
      "--jq 'select(.head.repo.full_name == .base.repo.full_name) | .head.ref')"
    );
    expect(staging).toMatch(/An empty `branch` is a pull request from a fork/);
    expect(staging).toContain('actions/workflows/<workflow>/dispatches');
    expect(staging).toContain('-f ref="$branch" -f "inputs[<baseInput>]=<integration>"');
    expect(staging).toMatch(/Leave out the `inputs` field when `<baseInput>` is null/);
  });

  it('refuses to dispatch on top of a run, or to retry a failure', () => {
    expect(staging).toMatch(/\*\*`success` or `pending`: do not dispatch\.\*\*/);
    expect(staging).toMatch(/\*\*`failing`: do not dispatch\.\*\*/);
    expect(staging).toMatch(/Never\s+dispatch a second time for the same head/);
    expect(staging).toMatch(/reported in one line and never retried/);
  });

  it('decides on fresh reads of the queries, not the watch or the read before the dispatch', () => {
    expect(staging).toMatch(/read the check-run query below every 30 seconds/);
    expect(staging).toMatch(/never from the read\s+before the dispatch/);
  });

  it('tells a moved head from a run that failed to start', () => {
    expect(staging).toMatch(/\*\*The head moved\*\*/);
    expect(staging).toMatch(/\*\*Otherwise the run failed to start:\*\*/);
  });

  it('stops on a dispatched run that skipped itself rather than waiting out the timeout', () => {
    expect(staging).toMatch(/the workflow\s+skipped itself on this head/);
  });

  it('waits for a late run only when step 5 could have started one', () => {
    expect(staging).toMatch(/up to 90 seconds before taking an empty\s+answer as final/);
    expect(staging).toMatch(/Otherwise one read is enough/);
  });

  it('still needs the configured workflow to succeed before it merges', () => {
    expect(staging).toMatch(/the configured workflow's\s+success is required too/);
  });
});

describe('GitHub calls work in a cloud session, which refuses GraphQL', () => {
  // `gh pr ready` is the one allowed, behind the cloud check: REST has no ready endpoint.
  const GRAPHQL = /gh pr (create|view|edit|checks|merge|comment|list|reopen|close|diff)\b/;

  it.each(['staging', 'build', 'ship', 'production'])('%s runs no gh pr call but ready', (name) => {
    const code = [...skill(name).matchAll(/```bash\n([^]*?)```/g)].map((m) => m[1]).join('\n');
    expect(code).not.toMatch(GRAPHQL);
    expect(code).not.toMatch(/gh api graphql/);
  });

  it.each(['staging', 'build'])('%s marks ready through the proxy in the cloud', (name) => {
    const text = skill(name);
    expect(text).toContain('`printenv CLAUDE_CODE_REMOTE` prints `true`');
    // A compound command no longer matches the `gh pr ready` grant.
    expect(text).not.toMatch(/if \[ "\$CLAUDE_CODE_REMOTE"/);
    expect(text).toContain(
      'gh api -X POST "repos/{owner}/{repo}/pulls/<number>/ccr/ready_for_review"'
    );
  });

  it('deletes the branch after the merge unless the config says not to, and warns on a 403', () => {
    const staging = skill('staging');
    expect(staging).toContain('gh api -X DELETE "repos/{owner}/{repo}/git/refs/heads/<branch>"');
    expect(staging).toMatch(/unless `branches\.deleteAfterMerge` is `false`/);
    expect(staging).toMatch(/A failure here is a warning, never a failed merge/);
    expect(staging).not.toContain('--delete-branch');
  });

  it('never names the pull request by a shell variable, which protect-merge refuses', () => {
    const staging = skill('staging');
    expect(staging).not.toMatch(/\bnumber=\$\(|\$number\b|pulls\/\$/);
    expect(staging).toMatch(/Write the number into every later command as a literal/);
  });
});

describe('skills pre-approve only scoped tools', () => {
  /** Every `allowed-tools` entry, inline or a YAML list at any indent, with quotes stripped. */
  const grants = (markdown) => {
    const lines = markdown.split(/\n---\n/)[0].split('\n');
    const at = lines.findIndex((line) => line.startsWith('allowed-tools:'));
    if (at === -1) return [];
    const inline = lines[at].slice('allowed-tools:'.length).trim();
    const items = [];
    if (inline) {
      // Split on commas outside parentheses: a grant can hold `%(refname)`.
      let depth = 0;
      let item = '';
      for (const char of `${inline},`) {
        if (char === ',' && depth === 0) {
          if (item.trim()) items.push(item.trim());
          item = '';
          continue;
        }
        if (char === '(') depth += 1;
        if (char === ')') depth -= 1;
        item += char;
      }
    } else {
      for (const line of lines.slice(at + 1)) {
        if (/^\s*(#.*)?$/.test(line)) continue;
        const item = line.match(/^\s*-\s+(.*)$/);
        if (!item) break;
        items.push(item[1]);
      }
    }
    return items.map((item) => item.trim().replace(/^(['"])(.*)\1$/, '$2'));
  };

  // A wildcard after one of these adds only arguments the command reads: no write, no upload,
  // no command it runs. `gh pr ready` takes only `--undo` besides the number.
  // `git diff` and `git log` take `--output=<file>`; that write is accepted for read-only skills
  // that would otherwise prompt on every diff.
  const READ_ONLY = [
    'git diff ',
    'git for-each-ref ',
    'git log ',
    'git ls-tree ',
    'git ls-files ',
    'git merge-base --is-ancestor ',
    'git rev-parse --verify --quiet ',
    'git status --porcelain ',
    'gh pr view ',
    'gh pr list ',
    'gh pr checks ',
    'gh run list ',
  ];
  // Plugin scripts whose every subcommand under the wildcard only reads, or writes only to the
  // tracker the skill is there to move. `scaffold.mjs apply` writes the project, so only `plan`.
  // An exact command passes only from this list, so a new one is a reviewed change here, not a
  // line that slips into a skill's frontmatter.
  const EXACT = [
    'git branch --show-current',
    'git check-ignore -q .env.local',
    'git config user.name',
    'git fetch --prune origin',
    'git fetch --quiet --prune origin',
    'git fetch origin',
    'git pull --ff-only',
    'git push -u origin HEAD',
    'sort -u',
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/canon-index.mjs"',
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/canon-index.mjs" --check',
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"',
  ];
  const SAFE_WILDCARDS = [
    'gh pr ready *',
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/tracker.mjs" *',
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/scaffold.mjs" plan *',
  ];
  const PLAIN_TOOLS = ['Read', 'Grep', 'Glob', 'AskUserQuestion'];

  const scoped = (grant) => {
    if (PLAIN_TOOLS.includes(grant)) return true;
    const bash = grant.match(/^Bash\((.+)\)$/);
    if (bash) {
      const command = bash[1];
      if (command.includes('..')) return false;
      // Claude Code ends the parenthesised part at the first `)`, so the rest of the grant is lost.
      if (command.includes(')')) return false;
      // A second command chained after a granted prefix rides on its approval.
      if (/[;&|`$<>\n]/.test(command.replaceAll('${CLAUDE_PLUGIN_ROOT}', ''))) return false;
      if (EXACT.includes(command) || SAFE_WILDCARDS.includes(command)) return true;
      return READ_ONLY.some((prefix) => command.startsWith(prefix));
    }
    const file = grant.match(/^(?:Edit|Write)\((.+)\)$/);
    // Under `.claude/` only the domain map: a grant on the settings would let a skill widen its own
    // permissions without a prompt.
    return (
      Boolean(file) &&
      /^\.\/(docs\/[^*]|\.claude\/canon-domains\.json$)/.test(file[1]) &&
      !file[1].includes('..')
    );
  };

  it.each(
    readdirSync(join(ROOT, 'skills'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  )('%s grants only listed exact commands, read-only commands and project paths', (name) => {
    for (const grant of grants(skill(name))) expect(scoped(grant), grant).toBe(true);
  });

  it.each([
    ['inline', 'allowed-tools: Read, Bash'],
    ['unindented list', 'allowed-tools:\n- Read\n- Bash'],
    ['deep list', 'allowed-tools:\n    - Read\n    - Bash'],
    ['quoted item', 'allowed-tools:\n  - Read\n  - "Bash"'],
    ['comment line', 'allowed-tools:\n  - Read\n  # shell\n  - Bash'],
    ['blank line', 'allowed-tools:\n  - Read\n\n  - Bash'],
  ])('reads a %s, so a reformatted grant is still checked', (_, front) => {
    expect(grants(`---\nname: x\n${front}\n---\n`)).toEqual(['Read', 'Bash']);
  });

  it('keeps an inline grant whole when it holds parentheses', () => {
    const front =
      "allowed-tools: Read, Bash(git for-each-ref --format='%(refname)' refs/remotes/origin)";
    expect(grants(`---\nname: x\n${front}\n---\n`)).toEqual([
      'Read',
      "Bash(git for-each-ref --format='%(refname)' refs/remotes/origin)",
    ]);
  });

  it.each([
    'Bash',
    'Bash(*)',
    'Bash(:*)',
    'Bash(git *)',
    'Bash(gh *)',
    'Bash(gh api *)',
    'Bash(git fetch *)',
    'Bash(git commit *)',
    'Bash(node *)',
    'Bash(gh pr edit * --body-file *)',
    'Edit',
    'Edit(**)',
    'Write(/**)',
    'Write(./**)',
    'Edit(./docs/../src/**)',
    'Edit(./.claude/settings.json)',
    'Write(./.claude/settings.local.json)',
    'Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/../../x.mjs" *)',
    'Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/../../x.mjs")',
    'Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/scaffold.mjs" *)',
    'Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" *)',
    'Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/scaffold.mjs" apply)',
    'Bash(git push --force origin HEAD)',
    'Bash(git reset --hard)',
    'Bash(gh pr merge --admin --squash)',
    'Bash(git status --porcelain * && git push --force origin HEAD)',
    'Bash(gh pr view *; gh pr merge --admin --squash)',
    'Bash(gh pr list * | sh)',
    'Bash(git ls-tree $(rm -rf .))',
    "Bash(git for-each-ref --format='%(refname)' refs/remotes/origin)",
  ])('refuses %s', (grant) => {
    expect(scoped(grant), grant).toBe(false);
  });
});
