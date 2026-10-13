/**
 * Which commands does this Bash call actually run, and does one of them, or a call
 * to a GitHub MCP server's merge tool, merge a pull request or push a branch?
 *
 * It exists because a regex over the raw command string cannot tell an invocation
 * from a mention of one. The commit whose message *describes* these hooks is the
 * canonical example, and a hook that refuses it trains people to bypass it.
 *
 * **Two readers live here, and they answer different questions.**
 *
 *   - `invocations` splits the string into simple commands, each into words with
 *     its quoting removed, and peels off the wrappers a command can hide behind:
 *     `command`, `exec`, `env` and its assignments, `nohup`, `time`, `timeout`,
 *     `xargs`, `sudo`, a path to the binary, and `sh -c`, `eval` or a shell fed its
 *     input, whose text is parsed again as a command of its own. `mergesIn`,
 *     `mergeTargets`, `prCalls` and `push-command.mjs` read it, because the guards
 *     on what ships have to see a merge or a push however it is spelled, and
 *     `require-canon.mjs` has to read flag values and a selector, not just a verb.
 *   - `commandSkeleton` is the older scanner: it masks quotes and heredoc bodies and
 *     leaves a string for a pattern to match. `writes-to-worktree.mjs` reads it,
 *     through `GIT` and `CMD_START`. It looks for a verb rather than judging a
 *     target, and a list of shapes is the right tool for that.
 *
 * **This is a tripwire, not a boundary.** It catches a merge or a push made by
 * mistake, or one an agent was talked into, in any spelling a shell reads the
 * usual way. `curl` with `GH_TOKEN`, an inline `python3` script, or a command
 * assembled in a variable walks past any string matcher, and nothing here tries
 * to follow them. The boundary is branch protection on GitHub: see the README.
 */

import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

/**
 * A `git` invocation including any global options that sit before the subcommand.
 *
 * **`git -C <path> push` and `git -c user.name=x commit` are ordinary forms**, and a
 * pattern that demands the subcommand be adjacent to `git` misses both. That let a
 * direct push to `main` past the push guard, and let every `git -c ... commit` past
 * the branch guard — which is the form this repository's own commits are made with,
 * so the guard was blind to exactly the command it was written for.
 *
 * `-C` and `-c` take a separate word; the rest carry their value with `=` or take
 * none. Anything not starting with a dash ends the run, which is the subcommand.
 */
export const GIT = 'git(?:\\s+(?:-[cC]\\s+\\S+|--?[A-Za-z][\\w-]*(?:=\\S+)?))*';

/**
 * Where a command can begin: the start of the string, or just after a separator,
 * then any number of things that precede a command without being one.
 *
 * **A separator alone is not enough.** `if true; then git push origin main; fi` puts
 * `then` between the `;` and the command, and `time git push origin main` puts a
 * wrapper at the very start. Both parsed as "no invocation" and walked straight past
 * every guard built on this anchor. So the run allows inline environment
 * assignments, shell keywords that introduce a command, and the wrappers that take
 * one as an argument.
 *
 * `!` is here because `! git push ...` negates the status, and `{` and `(` are in the
 * separator class because a group opens a command position too.
 */
export const CMD_START =
  '(?:^|[;&|\\n(){])\\s*' +
  '(?:!\\s*)?' +
  '(?:(?:then|else|elif|do|time|command|exec|nohup|builtin|eval|sudo|env)\\s+)*' +
  '(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*';

/**
 * The command reduced to the parts a shell would treat as syntax: heredoc bodies
 * removed, and quoted spans handled per `options.quoted`.
 *
 * **This is a left-to-right scan and not a set of regexes**, because regexes cannot
 * carry quote state and quote state spans lines (`--body "a\nb"` is one string
 * across two of them). Two failures made that concrete, opposite in kind: a
 * `<<EOF` inside a quoted string was read as a heredoc opener and discarded the
 * rest of the command, hiding a merge into `main`; and a `(` inside a commit
 * message looked like a command separator, refusing an ordinary commit.
 *
 * **Two modes, because quoted text is not one kind of thing.**
 *
 *   - `'neutralise'` (the default) keeps the text of a quoted span and defuses only
 *     the characters that would otherwise be read as syntax. It is what any matcher
 *     needs that cares about a *value*: `gh pr merge "$PR"` has to still show a
 *     selector, `git push origin "HEAD:main"` has to still show its refspec, and a
 *     quoted redirect target has to still be readable as a path. Blanking those
 *     spans is what made all three invisible, and every one of them failed open.
 *   - `'drop'` replaces a quoted span with whitespace. It is what a matcher needs
 *     that looks for a *verb*, because there the quoted text is data somebody is
 *     grepping for or writing about: `grep -rn "rm -rf" docs/` runs no `rm`, and
 *     `echo "see the mv section"` moves nothing.
 *
 * A newline inside a quoted span becomes a space in both modes, so it cannot be
 * mistaken for the command separator it looks like.
 *
 * Heredocs are handled line by line, the way a shell does: a body begins on the
 * line after its opener and runs to a line holding just the tag, and quote state is
 * suspended inside it, which stops an apostrophe in prose ("it's fine") from
 * opening a quote that swallows the rest of the command.
 */
const SYNTAX = /[;&|(){}<>]/;

export function commandSkeleton(command, { quoted = 'neutralise' } = {}) {
  if (typeof command !== 'string') return '';

  const drop = quoted === 'drop';
  const lines = command.split('\n');

  /** Masked lines, plus how each one joins to the next. */
  const out = [];
  const openAtEnd = [];
  const continued = [];

  // Tags whose bodies have been opened but not yet closed. One line may open more
  // than one (`cat <<A <<B`), and they close in order.
  const pending = [];
  let inSingle = false;
  let inDouble = false;

  /** Inside a quote: drop the character, or keep it unless it reads as syntax. */
  const masked = (c) => (drop ? ' ' : SYNTAX.test(c) ? '_' : c);

  for (const line of lines) {
    if (pending.length > 0) {
      // Inside a heredoc body. `<<-` allows a tab-indented terminator; plain `<<`
      // does not, and treating both leniently only ever ends a body early.
      if (line.trim() === pending[0]) pending.shift();
      out.push('');
      openAtEnd.push(false);
      continued.push(false);
      continue;
    }

    let result = '';
    let i = 0;
    // Set when this line ends with a backslash that joins it to the next one.
    let isContinuation = false;

    while (i < line.length) {
      const c = line[i];

      if (inSingle) {
        // No escapes inside single quotes.
        result += c === "'" ? ' ' : masked(c);
        if (c === "'") inSingle = false;
        i += 1;
        continue;
      }

      if (inDouble) {
        // A trailing backslash inside double quotes is a line continuation, the
        // same as outside them.
        if (c === '\\' && i + 1 === line.length) {
          isContinuation = true;
          i += 1;
          continue;
        }
        // A backslash escapes the next character, including a quote.
        if (c === '\\' && i + 1 < line.length) {
          result += drop ? '  ' : ' ' + masked(line[i + 1]);
          i += 2;
          continue;
        }
        result += c === '"' ? ' ' : masked(c);
        if (c === '"') inDouble = false;
        i += 1;
        continue;
      }

      // **A trailing backslash continues the command on the next line.** Without
      // this the backslash survives as a token and the newline still reads as a
      // separator, so `git push origin \\` + newline + `main` parsed its refspec
      // as `\\` and the push guard let a direct push to `main` through.
      if (c === '\\' && i + 1 === line.length) {
        isContinuation = true;
        i += 1;
        continue;
      }

      if (c === '\\' && i + 1 < line.length) {
        result += '  ';
        i += 2;
        continue;
      }

      if (c === "'") {
        inSingle = true;
        result += ' ';
        i += 1;
        continue;
      }

      if (c === '"') {
        inDouble = true;
        result += ' ';
        i += 1;
        continue;
      }

      // `<<<` is a herestring, which has no body and is not this.
      if (c === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
        const opener = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line.slice(i));
        if (opener) {
          pending.push(opener[2]);
          // Blanked, not kept: leaving the opener in place made an earlier version
          // rediscover it on a later pass and discard the rest of the command.
          result += ' '.repeat(opener[0].length);
          i += opener[0].length;
          continue;
        }
      }

      result += c;
      i += 1;
    }

    out.push(result);
    openAtEnd.push(inSingle || inDouble);
    continued.push(isContinuation);
  }

  // How each line joins the next. A backslash continuation removes the newline
  // outright, which is what the shell does and what keeps `origin \\` + newline +
  // `main` a single argument list. A newline inside a quoted span becomes a space,
  // so it cannot act as the command separator it resembles. Everything else keeps
  // its newline, which is a separator and has to stay one.
  let joined = out[0] ?? '';
  for (let i = 1; i < out.length; i += 1) {
    const separator = continued[i - 1] ? '' : openAtEnd[i - 1] ? ' ' : '\n';
    joined += separator + out[i];
  }
  return joined;
}

/**
 * `null` when the command does not invoke one of the named `gh pr` subcommands.
 * Otherwise which one it was, and the selector to pass to `gh pr view`: a
 * one-element array holding a number or a URL, or an empty array, which means the
 * pull request for the current branch.
 *
 * Generic over the subcommand so a caller names the ones it watches. No hook reads
 * it any more: `require-canon.mjs` moved to `prCalls`, which reads flags and the
 * selector properly, and `protect-merge.mjs` guards what ships, so it reads
 * `mergesIn`, which sees through `bash -c`, `eval`, `gh api` and the MCP merge tool.
 *
 * **The selector is best-effort**: it is the first word that does not start with
 * a dash, so a flag taking a value hands back that value instead. `gh pr create
 * --base staging` reports `staging`, which is not a pull request at all. Do not
 * add a caller that needs the selector to be right; `mergesIn` is the reader for
 * one that does.
 *
 * `unresolved` is set when the selector carries a shell expansion — `$PR`,
 * `${PR}`, a backtick or a `$(...)` — which this cannot evaluate and must not
 * guess at.
 */
export function prInvocations(command, subcommands) {
  if (typeof command !== 'string') return [];

  const skeleton = commandSkeleton(command);
  const alternation = subcommands.join('|');

  // **Every invocation, not the first.** `gh pr create ... && gh pr merge 42` used to
  // report only the create, so the merge reached no guard at all. The same shape hid
  // a second `git push` from the push guard.
  const pattern = new RegExp(`${CMD_START}gh\\s+pr\\s+(${alternation})\\b([^\\n;&|)]*)`, 'g');

  const found = [];
  for (const invocation of skeleton.matchAll(pattern)) {
    const selector = invocation[2]
      ?.trim()
      .split(/\s+/)
      .find((word) => word && !word.startsWith('-'));

    found.push({
      subcommand: invocation[1],
      selector: selector ? [selector] : [],
      // A `$(...)` or backtick substitution survives outside quotes, so the bare
      // forms still arrive here.
      unresolved: selector !== undefined && /[$`]/.test(selector),
    });
  }
  return found;
}

/**
 * The first invocation, or `null`. For a caller that only needs to know whether one
 * is present; anything deciding whether to refuse should read them all.
 */
export function prSubcommand(command, subcommands) {
  return prInvocations(command, subcommands)[0] ?? null;
}

/**
 * Where one simple command ends and the next can start. `(` covers `$(...)` and
 * a subshell, and a backtick covers the older substitution.
 */
const SEPARATORS = new Set([';', '&', '|', '\n', '(', ')', '`']);

/** `>file`, `2>&1`, `&>/dev/null`, `<file`: a redirection, not an argument. */
const REDIRECT = /^(?:\d+|&)?(?:>>?|<|>&|<&|>\|)(.*)$/;

/**
 * Split a command string into simple commands, each `{ words, stdin,
 * substitutions }`: the words with their quoting removed, the text fed to its
 * standard input, and the command lines it runs inside double quotes.
 *
 * A word that began outside quotes is `bare`, which is what separates a
 * redirection from a quoted `>` in a commit message.
 *
 * Heredocs and here-strings are read here, as the shell reads them, rather than
 * stripped from the text first. A quoted `<<EOF` in a commit message is then
 * prose, not the start of a body that hides the next line, and a body is kept
 * as the command's standard input, because `bash <<EOF` runs it. For any other
 * command a body is prose and nothing reads it.
 *
 * A double-quoted string is prose except for a `$(...)` or backtick inside it,
 * which the shell runs: `out="$(gh pr merge 5)"` merges.
 */
function simpleCommands(command) {
  const fresh = () => ({ words: [], stdin: [], substitutions: [], pipedFrom: null });
  const commands = [fresh()];
  const heredocs = [];
  let word = null;
  let pending = null;

  const start = (bare) => (word ??= { text: '', bare });
  const endWord = () => {
    if (word && pending === 'herestring') commands.at(-1).stdin.push(word.text);
    else if (word && pending) heredocs.push({ ...pending, tag: word.text, into: commands.at(-1) });
    else if (word) commands.at(-1).words.push(word);
    if (word) pending = null;
    word = null;
  };
  const endCommand = (pipe = false) => {
    endWord();
    if (commands.at(-1).words.length === 0) return;
    const previous = commands.at(-1);
    commands.push(fresh());
    // `echo ... | bash` runs what the left side prints, so the right side keeps
    // a reference to the left.
    if (pipe) commands.at(-1).pipedFrom = previous;
  };

  /** Read every body queued on this line, starting after the newline at `i`. */
  const readBodies = (i) => {
    let at = i + 1;
    for (const heredoc of heredocs.splice(0)) {
      const lines = [];
      for (;;) {
        if (at >= command.length) break;
        const eol = command.indexOf('\n', at);
        const stop = eol === -1 ? command.length : eol;
        const line = command.slice(at, stop);
        at = stop + 1;
        if ((heredoc.strip ? line.replace(/^\t+/, '') : line).trim() === heredoc.tag) break;
        lines.push(line);
      }
      heredoc.into.stdin.push(lines.join('\n'));
    }
    // Back onto the newline that ended the last terminator, which the loop then
    // reads as a separator.
    return Math.min(at, command.length) - 1;
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i];

    if (arithmeticEnd(command, c === '$' ? i + 1 : i) !== -1) {
      // Arithmetic, `$((1 << 2))` or `(( n <<= 1 ))`: a `<<` there is a shift,
      // not a heredoc whose tag would hide every later line.
      const stop = arithmeticEnd(command, c === '$' ? i + 1 : i);
      // A `$(...)` or backtick inside arithmetic still runs, so its body is kept
      // like one inside double quotes.
      for (let j = i + 3; j < stop; j++) {
        if (command[j] === '$' && command[j + 1] === '(' && command[j + 2] !== '(') {
          const close = closingParen(command, j + 2);
          commands.at(-1).substitutions.push(command.slice(j + 2, close));
          j = close;
        } else if (command[j] === '`') {
          const close = command.indexOf('`', j + 1);
          const end = close === -1 || close > stop ? stop : close;
          commands.at(-1).substitutions.push(command.slice(j + 1, end));
          j = end;
        }
      }
      start(true).text += command.slice(i, stop + 1);
      i = stop;
    } else if (c === '$' && command[i + 1] === "'") {
      // `$'a\\'b'`: a backslash escapes the next character, so a quote can sit
      // inside, and `\\n` is a newline, which separates commands in `bash -c`.
      const stop = closingQuote(command, i + 1);
      start(false).text += command
        .slice(i + 2, stop)
        .replace(/\\(.)/g, (_, next) => ANSI_ESCAPES[next] ?? next);
      i = stop;
    } else if (c === "'") {
      const close = command.indexOf("'", i + 1);
      const stop = close === -1 ? command.length : close;
      start(false).text += command.slice(i + 1, stop);
      i = stop;
    } else if (c === '"') {
      let j = i + 1;
      let text = '';
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\' && '"\\$`'.includes(command[j + 1] ?? '')) {
          j++;
        } else if (command[j] === '$' && command[j + 1] === '(') {
          const close = closingParen(command, j + 2);
          commands.at(-1).substitutions.push(command.slice(j + 2, close));
          text += command.slice(j, close + 1);
          j = close + 1;
          continue;
        } else if (command[j] === '`') {
          const close = command.indexOf('`', j + 1);
          const stop = close === -1 ? command.length : close;
          commands.at(-1).substitutions.push(command.slice(j + 1, stop));
          text += command.slice(j, stop + 1);
          j = stop + 1;
          continue;
        }
        text += command[j];
        j++;
      }
      start(false).text += text;
      i = j;
    } else if (c === '\\') {
      // A backslash before a newline is a line continuation and joins the words.
      if (command[i + 1] !== '\n') start(true).text += command[i + 1] ?? '';
      i++;
    } else if (c === '#' && word === null) {
      const eol = command.indexOf('\n', i);
      i = eol === -1 ? command.length : eol - 1;
    } else if (c === '<' && command[i + 1] === '<') {
      // `<<<` takes the next word as standard input; `<<` and `<<-` take the
      // next word as the tag whose body starts on the following line.
      endWord();
      if (command[i + 2] === '<') {
        pending = 'herestring';
        i += 2;
      } else {
        const strip = command[i + 2] === '-';
        pending = { strip };
        i += strip ? 2 : 1;
      }
    } else if (c === ' ' || c === '\t') {
      endWord();
    } else if (c === '\n') {
      endWord();
      if (heredocs.length > 0) i = readBodies(i);
      endCommand();
    } else if (SEPARATORS.has(c)) {
      // The ampersand in `2>&1` or `&>file` is part of a redirection, not a
      // separator. Splitting there would make `/dev/null` a command.
      if (c === '&' && ('<>'.includes(command[i - 1]) || command[i + 1] === '>')) {
        start(true).text += c;
      } else if (c === '|' && command[i + 1] === '|') {
        endCommand();
        i++;
      } else {
        endCommand(c === '|');
        if (c === '|' && command[i + 1] === '&') i++;
      }
    } else {
      start(true).text += c;
    }
  }
  endCommand();

  // In place rather than mapped, so each `pipedFrom` still points at a command
  // in the returned list.
  for (const one of commands) one.words = dropRedirects(one.words);
  return commands.filter((one) => one.words.length > 0);
}

/** What a backslash sequence in `$'...'` stands for; any other escaped character is itself. */
const ANSI_ESCAPES = { n: '\n', t: '\t', r: '\r' };

/**
 * The index of the second `)` closing arithmetic opened by the `((` at `open`,
 * or -1 when those brackets are not arithmetic. Bash reads `((...))` as
 * arithmetic only when the two closing brackets are adjacent; `((cmd) )` is a
 * subshell inside a subshell and runs `cmd`.
 */
function arithmeticEnd(command, open) {
  if (command[open] !== '(' || command[open + 1] !== '(') return -1;
  const inner = closingParen(command, open + 2);
  return command[inner + 1] === ')' ? inner + 1 : -1;
}

/** The index of the `)` closing a `$(` whose body starts at `from`, or the end. */
function closingParen(command, from) {
  let depth = 1;
  const tags = [];

  for (let i = from; i < command.length; i++) {
    const c = command[i];
    // A bracket inside quotes or a heredoc body is text: `git commit -m "$(cat
    // <<'EOF' ... :-( ... EOF)"` would otherwise swallow everything after it.
    if (c === '\\') {
      i++;
    } else if (c === "'" || (c === '$' && command[i + 1] === "'")) {
      i = closingQuote(command, c === '$' ? i + 1 : i);
    } else if (c === '"') {
      for (i++; i < command.length && command[i] !== '"'; i++) {
        if (command[i] === '\\') i++;
        else if (command[i] === '$' && command[i + 1] === '(') i = closingParen(command, i + 2);
      }
    } else if (c === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      const tag = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(command.slice(i));
      if (tag) {
        tags.push(tag[2]);
        i += tag[0].length - 1;
      }
    } else if (c === '\n' && tags.length > 0) {
      for (const tag of tags.splice(0)) {
        for (;;) {
          const eol = command.indexOf('\n', i + 1);
          const line = command.slice(i + 1, eol === -1 ? command.length : eol);
          i = eol === -1 ? command.length : eol;
          if (line.trim() === tag || eol === -1) break;
        }
      }
      // `i` is on the newline ending the last terminator; the loop steps past it.
    } else if (c === '(') {
      depth++;
    } else if (c === ')' && --depth === 0) {
      return i;
    }
  }
  return command.length;
}

/**
 * The index of the `'` closing a single-quoted string opened at `from`. Inside
 * `$'...'` a backslash escapes the next character, `\\'` included; inside plain
 * single quotes nothing does.
 */
function closingQuote(command, from) {
  const ansi = command[from - 1] === '$';
  for (let i = from + 1; i < command.length; i++) {
    if (ansi && command[i] === '\\') i++;
    else if (command[i] === "'") return i;
  }
  return command.length;
}

function dropRedirects(words) {
  const kept = [];
  for (let i = 0; i < words.length; i++) {
    const redirect = words[i].bare ? REDIRECT.exec(words[i].text) : null;
    if (!redirect) kept.push(words[i].text);
    // `> file` takes the next word as its target; `>file` already holds it.
    else if (redirect[1] === '') i++;
  }
  return kept;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Words that come before a command without being it. */
const RESERVED = new Set(['!', '{', 'if', 'then', 'elif', 'else', 'while', 'until', 'do']);

/** Wrappers that run the rest of the line as the command, and their options taking a value. */
const WRAPPERS = new Map([
  ['command', new Set()],
  ['exec', new Set(['-a'])],
  ['builtin', new Set()],
  ['nohup', new Set()],
  ['time', new Set(['-f', '-o'])],
  ['timeout', new Set(['-s', '-k', '--signal', '--kill-after'])],
  ['nice', new Set(['-n'])],
  [
    'xargs',
    new Set([
      ...['-n', '-L', '-I', '-P', '-s', '-d', '-E', '-a', '-J', '-R', '-S'],
      ...['--max-args', '--max-lines', '--max-procs', '--delimiter', '--arg-file'],
    ]),
  ],
  ['env', new Set(['-u', '-C', '-P', '--unset', '--chdir'])],
  ['sudo', new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U'])],
]);

/** Wrappers that take a fixed number of operands before the command: `timeout 600 gh ...`. */
const OPERANDS = new Map([['timeout', 1]]);

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

/** Shell options taking the next word, so `bash -o pipefail -c "..."` finds the script. */
const SHELL_VALUES = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);

/** Deep enough for `bash -c "eval 'gh pr merge 5'"`, and a stop for anything built to loop. */
const MAX_DEPTH = 4;

/**
 * Every command the string runs, each as `{ argv, env }`: `argv[0]` is the bare
 * program name with any path dropped, and `env` holds the inline assignments that
 * preceded it, `GH_REPO=x gh ...` included.
 *
 * `inherited` carries those assignments into a command line a wrapper runs, so
 * `GH_REPO=x bash -c "gh pr merge 5"` still names the other repository.
 */
export function invocations(command, depth = 0, inherited = {}) {
  if (typeof command !== 'string' || depth > MAX_DEPTH) return [];

  // `export GH_REPO=x; gh pr merge 5` sets it for every command after it. A bare
  // `GH_REPO=x;` is only exported if it already was, and is kept anyway: reading
  // a merge as aimed elsewhere fails closed, which is the safe direction.
  const shared = { ...inherited };
  const found = [];
  for (const { words, stdin, substitutions, pipedFrom } of simpleCommands(command)) {
    // A substitution runs with what was exported before it, so
    // `export GH_REPO=x; out="$(gh pr merge 5)"` still names the other repository.
    for (const inner of substitutions) found.push(...invocations(inner, depth + 1, shared));

    const declaration = ['export', 'declare', 'typeset', 'readonly'].includes(words[0]);
    if (declaration || words.every((word) => ASSIGNMENT.test(word))) {
      for (const word of words) {
        if (!ASSIGNMENT.test(word)) continue;
        const [name, ...value] = word.split('=');
        shared[name] = value.join('=');
      }
      continue;
    }
    if (words[0] === 'unset') {
      for (const name of words.slice(1)) delete shared[name];
      continue;
    }
    const piped = printed(pipedFrom);
    found.push(...unwrap(words, piped === null ? stdin : [...stdin, piped], depth, shared));
  }

  return found;
}

/**
 * What a command on the left of a pipe prints, when it is one whose output can
 * be read off the line: `cat` with a heredoc or here-string, `echo`, `printf`.
 * Anything else, `curl ... | bash` included, is `null`: not followed.
 */
function printed(command) {
  if (!command) return null;
  const [name, ...args] = command.words;
  if (name === 'cat' && command.stdin.length > 0) return command.stdin.join('\n');
  if (name === 'echo') return args.filter((arg) => !/^-[neE]+$/.test(arg)).join(' ');
  if (name === 'printf') return args.join(' ').replace(/\\n/g, '\n');
  return null;
}

function unwrap(words, stdin, depth, inherited) {
  const env = { ...inherited };
  const argv = [...words];
  // `xargs` appends words read from its input, so what it runs is not all here.
  let appended = false;

  for (;;) {
    while (argv.length > 0 && ASSIGNMENT.test(argv[0])) {
      const [name, ...value] = argv.shift().split('=');
      env[name] = value.join('=');
    }
    if (argv.length === 0) return [];

    const name = basename(argv[0]);

    if (RESERVED.has(name)) {
      argv.shift();
      continue;
    }

    // `function f { gh pr merge 5; }`: the keyword and the name come off, and
    // the `{` after them is reserved. `f() { ... }` splits at its brackets.
    if (name === 'function') {
      argv.splice(0, 2);
      continue;
    }

    const wrapperValues = WRAPPERS.get(name);
    if (wrapperValues) {
      if (name === 'xargs') appended = true;
      argv.shift();
      while (argv[0]?.startsWith('-')) {
        // `command -v gh` looks the name up; it runs nothing.
        if (name === 'command' && /^-[vV]$/.test(argv[0])) return [];
        // `env -S "gh pr merge 5"` splits its value into the command it runs, so
        // the value is a command line, parsed like `sh -c`'s.
        const split = name === 'env' && /^(?:-S|--split-string)(?:=?)(.*)$/.exec(argv[0]);
        if (split) {
          argv.shift();
          const line = split[1] || argv.shift() || '';
          return invocations([line, ...argv].join(' '), depth + 1, env);
        }
        if (wrapperValues.has(argv.shift())) argv.shift();
      }
      argv.splice(0, OPERANDS.get(name) ?? 0);
      continue;
    }

    if (SHELLS.has(name)) {
      let command = false;
      let fromStdin = false;
      let script;
      for (let i = 1; i < argv.length; i++) {
        const arg = argv[i];
        if (SHELL_VALUES.has(arg)) i++;
        else if (/^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) command = true;
        else if (/^-[A-Za-z]*s[A-Za-z]*$/.test(arg)) fromStdin = true;
        else if (!/^[-+]/.test(arg)) {
          script = arg;
          break;
        }
      }
      if (command && script !== undefined) return invocations(script, depth + 1, env);
      // `bash <<EOF`, `sh -s <<EOF` and `bash <<< "..."` run their input.
      if ((fromStdin || script === undefined) && stdin.length > 0) {
        return invocations(stdin.join('\n'), depth + 1, env);
      }
    }

    if (name === 'eval') return invocations(argv.slice(1).join(' '), depth + 1, env);

    return [{ argv: [name, ...argv.slice(1)], env, appended }];
  }
}

/**
 * Split arguments into positionals and the flags that were set. `values` names
 * the flags that take the next word as their value, which is what keeps
 * `--subject "x"` from being read as the pull request `x`.
 *
 * `flags` keeps the last value of each flag; `pairs` keeps every one in order,
 * for a flag like `gh api -f` that is given once per field.
 */
export function parseArgs(args, values) {
  const positionals = [];
  const pairs = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const [name, ...inline] = arg.split('=');
      const value = inline.length > 0 ? inline.join('=') : values.has(name) ? args[++i] : true;
      pairs.push([name, value]);
    } else if (arg.startsWith('-') && arg.length > 1) {
      // A cluster of short flags, `-dt 7` or `-iX PUT`: each letter is a flag
      // until one takes a value, which is the rest of the word or the next one.
      for (let k = 1; k < arg.length; k++) {
        const name = `-${arg[k]}`;
        if (!values.has(name)) {
          pairs.push([name, true]);
          continue;
        }
        pairs.push([name, k < arg.length - 1 ? arg.slice(k + 1) : args[++i]]);
        break;
      }
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flags: new Map(pairs), pairs };
}

const PR_MERGE_VALUES = new Set([
  '--subject',
  '-t',
  '--body',
  '-b',
  '--body-file',
  '-F',
  '--author-email',
  '-A',
  '--match-head-commit',
  '--repo',
  '-R',
]);

/**
 * The flags each `gh pr` subcommand takes a value for. Per subcommand because they
 * disagree: `-m` is `--milestone` on `create` and the boolean `--merge` on `merge`,
 * and reading it as a value there would swallow the selector after it.
 */
const PR_VALUES = {
  create: new Set([
    ...['--base', '-B', '--head', '-H', '--title', '-t', '--body', '-b', '--body-file', '-F'],
    ...['--assignee', '-a', '--label', '-l', '--milestone', '-m', '--project', '-p'],
    ...['--reviewer', '-r', '--template', '-T', '--recover', '--repo', '-R'],
  ]),
  ready: new Set(['--repo', '-R']),
  merge: PR_MERGE_VALUES,
};

/**
 * Every `gh pr` invocation of the named subcommands, read through `invocations`,
 * so quoting is removed and a flag inside a quoted `--body` stays that flag's
 * value. `env` is the assignments in force for that one command, inline or
 * exported before it.
 *
 * `require-canon.mjs` reads this rather than `prInvocations` because it needs what
 * the skeleton cannot give: `-B main` and `--base "main"` as well as `--base main`,
 * a real selector, and a bypass set on the command itself.
 */
export function prCalls(command, subcommands) {
  const found = [];
  for (const { argv, env, appended } of invocations(command)) {
    if (argv[0] !== 'gh' || argv[1] !== 'pr') continue;
    // `-R` is a group flag and can come first: `gh pr -R o/r merge 5`.
    const rest = argv.slice(2);
    let at = 0;
    while (rest[at]?.startsWith('-')) at += /^(?:-R|--repo)$/.test(rest[at]) ? 2 : 1;
    const subcommand = rest[at];
    if (!subcommands.includes(subcommand)) continue;
    const args = [...rest.slice(0, at), ...rest.slice(at + 1)];
    const { positionals, flags, pairs } = parseArgs(args, PR_VALUES[subcommand] ?? new Set());
    found.push({ subcommand, positionals, flags, pairs, env, appended });
  }
  return found;
}

const API_VALUES = new Set([
  '-X',
  '--method',
  '-f',
  '--raw-field',
  '-F',
  '--field',
  '-H',
  '--header',
  '--input',
  '-q',
  '--jq',
  '-t',
  '--template',
  '--hostname',
  '--cache',
  '-p',
  '--preview',
]);

/** The `gh api` flags that give the request a body, which makes its default method POST. */
const API_BODY = new Set(['-f', '--raw-field', '-F', '--field', '--input']);

/**
 * Relative, or a full URL on api.github.com or an Enterprise host's `/api/v3`.
 * The last group is the merge itself or the `ccr/auto_merge` route a Claude Code
 * cloud session's proxy adds, which merges the pull request once its checks pass.
 * No session here runs in the cloud, and the route is guarded anyway: a guard that
 * reads one spelling of a merge and not another is the gap these hooks keep closing.
 */
const API_MERGE =
  /^(?:https?:\/\/[^/]+(?:\/api\/v3)?)?\/?(?:repos\/(?<owner>[^/]+)\/(?<repo>[^/]+)|repositories\/(?<id>\d+))\/pulls\/(?<number>\d+)\/(?<route>merge|ccr\/auto_merge)\/?(?:\?.*)?$/;

/**
 * The methods that merge, per endpoint. A DELETE on `auto_merge` turns it off,
 * and a GET on either asks rather than acts.
 */
const MERGE_METHODS = { merge: ['PUT'], 'ccr/auto_merge': ['PUT', 'POST'] };

/**
 * Writes that land on a branch with no pull request at all: the merges endpoint,
 * which merges one ref into another, a write to a branch's ref, which moves,
 * creates or deletes it outright, a file written through the contents API, a fork
 * synced with `merge-upstream`, and a change to a branch's protection or name.
 */
const API_REPO =
  /^(?:https?:\/\/[^/]+(?:\/api\/v3)?)?\/?(?:repos\/[^/]+\/[^/]+|repositories\/\d+)\//;
const API_MERGES = /^merges\/?(?:\?.*)?$/;
const API_REF = /^git\/refs\/heads\/(.+?)\/?(?:\?.*)?$/;
const API_REFS = /^git\/refs\/?(?:\?.*)?$/;
const API_CONTENTS = /^contents(?:\/|\?|$)/;
const API_UPSTREAM = /^merge-upstream\/?(?:\?.*)?$/;
const API_BRANCH = /^branches\/(.+?)(?:\/(?:protection|rename)(?:\/[^?]*)?)?\/?(?:\?.*)?$/;

/** `main`, `heads/main` and `refs/heads/main` name one branch. */
const bareBranch = (ref) => ref.replace(/^(?:refs\/)?heads\//, '');

/**
 * A value whose text is not on the line: from a file (`@`), a variable, a
 * substitution, or gh's `{branch}` placeholder, which is whatever is checked out.
 * A bare backtick separates words here, so `base=` followed by one reads as empty.
 */
const unreadable = (value) => /^$|^@|\$|`|\{branch\}/.test(value);

/** Each `-f`/`-F` field as `[name, value]`, in order. `--input` gives none. */
function bodyFields(pairs) {
  return pairs
    .filter(
      ([flag, field]) => API_BODY.has(flag) && flag !== '--input' && typeof field === 'string'
    )
    .map(([, field]) => {
      const at = field.indexOf('=');
      return at === -1 ? [field, ''] : [field.slice(0, at), field.slice(at + 1)];
    });
}

/**
 * `{ branch }` for a field that names the branch a write lands on, and
 * `{ branch: null }` when the field is missing or its value is not on the line:
 * a contents write with no `branch` goes to the default branch, which is often
 * production.
 */
function branchField(fields, name) {
  const value = fields.filter(([key]) => key === name).at(-1)?.[1];
  if (value === undefined || unreadable(value)) return { branch: null };
  return { branch: bareBranch(value) };
}

/**
 * `{ branch }` for a merge or ref write made without a pull request, naming the
 * branch it lands on, and `{ branch: null }` for one whose branch cannot be read.
 * Any other write to the repository is `{ writes }`: every path segment and field
 * value it names, so the caller can refuse one that names production however it
 * reaches it. `null` for a read. The caller decides which branches matter: a write
 * to a feature branch's ref is cleanup, not a merge, and passes.
 */
function directWrite(endpoint, method, pairs) {
  const repo = API_REPO.exec(endpoint);
  if (!repo || method === 'GET' || method === 'HEAD') return null;
  const rest = endpoint.slice(repo[0].length);
  const fields = bodyFields(pairs);

  if (API_MERGES.test(rest)) return method === 'POST' ? branchField(fields, 'base') : null;
  if (API_UPSTREAM.test(rest)) return branchField(fields, 'branch');
  if (API_CONTENTS.test(rest) && (method === 'PUT' || method === 'DELETE')) {
    return branchField(fields, 'branch');
  }

  // Creating a ref names it in the body. A tag is not a branch, and falls through.
  if (API_REFS.test(rest) && method === 'POST') {
    const ref = fields.filter(([key]) => key === 'ref').at(-1)?.[1];
    if (ref === undefined || unreadable(ref)) return { branch: null };
    if (/^refs\/heads\//.test(ref)) return { branch: bareBranch(ref) };
  }

  const ref = API_REF.exec(rest)?.[1];
  if (ref !== undefined) {
    // `{branch}` is the checked-out branch, which may be production. A ref named by
    // a shell variable is not judged: a cleanup names the merged branch as
    // `heads/$branch`, and refusing it would refuse every one.
    if (ref === '{branch}') return { branch: null };
    return { branch: decode(ref) };
  }

  const branch = API_BRANCH.exec(rest)?.[1];
  if (branch !== undefined) {
    return unreadable(branch) ? { branch: null } : { branch: decode(branch) };
  }

  const named = [
    ...rest.replace(/\?.*$/, '').split('/').filter(Boolean).map(decode),
    ...fields.map(([, value]) => value),
  ].map(bareBranch);
  return named.length ? { writes: named } : null;
}

function decode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const API_GRAPHQL = /^(?:https?:\/\/[^/]+(?:\/api)?)?\/?graphql\/?(?:\?.*)?$/;

/**
 * Mutations that move, create or delete a branch or its commits, merge into one,
 * or loosen what protects it. Each names its branch by node ID, so whether it is
 * production cannot be read off the command, and each is refused.
 */
export const BRANCH_MUTATIONS = new Set([
  'mergePullRequest',
  'enablePullRequestAutoMerge',
  'enqueuePullRequest',
  'mergeBranch',
  'createRef',
  'updateRef',
  'updateRefs',
  'deleteRef',
  'createCommitOnBranch',
  'updateBranchProtectionRule',
  'deleteBranchProtectionRule',
  'updateRepositoryRuleset',
  'deleteRepositoryRuleset',
]);

const GRAPHQL_TOKEN =
  /\s+|,|#[^\n]*|"""(?:\\"""|[^])*?"""|"(?:\\.|[^"\\\n])*"|\.\.\.|[{}()[\]:!$@=|&]|[_A-Za-z][_0-9A-Za-z]*|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** A GraphQL document as tokens, strings unquoted. `null` when it is not one. */
function graphqlTokens(text) {
  const tokens = [];
  GRAPHQL_TOKEN.lastIndex = 0;
  while (GRAPHQL_TOKEN.lastIndex < text.length) {
    const at = GRAPHQL_TOKEN.lastIndex;
    const match = GRAPHQL_TOKEN.exec(text);
    if (!match) return null;
    const [token] = match;
    if (/^\s|^,|^#/.test(token)) continue;
    if (token.startsWith('"')) {
      const body = token.startsWith('"""') ? token.slice(3, -3) : token.slice(1, -1);
      tokens.push({ string: body.replace(/\\(.)/g, '$1') });
    } else tokens.push({ at, text: token });
  }
  return tokens;
}

/**
 * The top-level fields of every mutation in a GraphQL document, and every string
 * it holds. `null` when the document cannot be read well enough to say what it
 * mutates: not GraphQL, a fragment spread at the top of a mutation, or a field
 * name that is not a literal name. A document with no mutation gives no fields.
 */
export function graphqlMutations(text) {
  const tokens = graphqlTokens(text);
  if (tokens === null || tokens.length === 0) return null;
  const fields = [];
  const strings = tokens.filter((t) => 'string' in t).map((t) => t.string);
  const word = (i) => tokens[i]?.text;

  let i = 0;
  while (i < tokens.length) {
    const kind = word(i);
    if (kind !== '{' && !['query', 'mutation', 'subscription', 'fragment'].includes(kind)) {
      return null;
    }
    // Up to the operation's selection set, past any variable definitions.
    let parens = 0;
    while (i < tokens.length && !(word(i) === '{' && parens === 0)) {
      if (word(i) === '(') parens += 1;
      if (word(i) === ')') parens -= 1;
      i += 1;
    }
    if (i >= tokens.length) return null;

    let depth = 0;
    let found = 0;
    parens = 0;
    for (; i < tokens.length; i += 1) {
      const token = word(i);
      // A `$` past the variable definitions is a variable whose value this cannot
      // see, or a shell substitution that never happened. Either way, unreadable.
      if (kind === 'mutation' && token === '$') return null;
      if (token === '(') parens += 1;
      else if (token === ')') parens -= 1;
      else if (parens > 0 || token === undefined) continue;
      else if (token === '{') depth += 1;
      else if (token === '}') {
        depth -= 1;
        if (depth === 0) break;
      } else if (kind === 'mutation' && depth === 1) {
        if (token === '...') return null;
        if (token === '@') {
          i += 1;
          continue;
        }
        if (!/^[_A-Za-z]/.test(token)) continue;
        // `alias: field` names the field second.
        fields.push(word(i + 1) === ':' ? word(i + 2) : token);
        found += 1;
        if (word(i + 1) === ':') i += 2;
      }
    }
    if (depth !== 0) return null;
    // A mutation with no field this can name mutates something it cannot see.
    if (kind === 'mutation' && found === 0) return null;
    i += 1;
  }
  if (fields.some((field) => field === undefined || !/^[_A-Za-z]\w*$/.test(field))) return null;
  return { fields, strings };
}

/**
 * A `gh api graphql` call: `{ mutation: fields, writes }` for one that mutates,
 * `{ mutation: null, writes }` for a document this cannot read (`-F query=@file`,
 * `--input`, a variable), and `null` for a read. `writes` is every string and
 * field value it carries, judged like a REST write's.
 */
function graphqlCall(pairs) {
  const fields = bodyFields(pairs);
  const values = fields.filter(([key]) => key !== 'query').map(([, value]) => value);
  const query = fields.filter(([key]) => key === 'query').at(-1)?.[1];
  const input = pairs.some(([flag]) => flag === '--input');
  if (query === undefined) return input ? { mutation: null, writes: values } : null;
  if (query.startsWith('@')) return { mutation: null, writes: values };

  const read = graphqlMutations(query);
  if (read === null) return { mutation: null, writes: values };
  if (read.fields.length === 0) return null;
  return { mutation: read.fields, writes: [...values, ...read.strings].map(bareBranch) };
}

/**
 * `null` when the command runs no merge. `{ selector: [...] }` is what to pass to
 * `prDetails`: a number or URL, or nothing for the current branch.
 * `{ selector: null }` is a merge whose target cannot be read, and each hook
 * keeps its own answer to that. `{ branch }` is a write with no pull request,
 * and `{ writes }` any other write with what it names, from `directWrite`.
 * `{ mutation }` is a GraphQL mutation, from `graphqlCall`.
 */
function mergeOf({ argv, env, appended }) {
  if (argv[0] !== 'gh') return null;

  // `-R` belongs to the `pr` group, so `gh pr -R o/r merge 5` is a merge too:
  // the flags are parsed across the whole group and `merge` is the first word.
  const group = argv[1] === 'pr' ? parseArgs(argv.slice(2), PR_MERGE_VALUES) : null;
  if (group?.positionals[0] === 'merge') {
    const { flags } = group;
    const positionals = group.positionals.slice(1);
    // This repository only ever merges its own pull requests, so a merge aimed at
    // another one is not something this hook can judge by number.
    // Nor is one whose pull request `xargs` supplies from its input.
    if (flags.has('--repo') || flags.has('-R') || env.GH_REPO !== undefined || appended) {
      return { selector: null };
    }
    return { selector: positionals.slice(0, 1) };
  }

  if (argv[1] === 'api') {
    const { positionals, flags, pairs } = parseArgs(argv.slice(2), API_VALUES);
    const endpoint = positionals[0] ?? '';

    if (API_GRAPHQL.test(endpoint)) return graphqlCall(pairs);

    // `gh api` sends GET, or POST once a field or an input is given, unless the
    // method is named.
    const named = flags.get('--method') ?? flags.get('-X');
    const sends = [...flags.keys()].some((flag) => API_BODY.has(flag)) ? 'POST' : 'GET';
    const method = (typeof named === 'string' ? named : sends).toUpperCase();

    const path = API_MERGE.exec(endpoint);
    if (!path) return directWrite(endpoint, method, pairs);
    const { owner, repo, id, number, route } = path.groups;
    if (!MERGE_METHODS[route].includes(method)) return null;
    // `repositories/<id>` names a repository by number, which `prDetails` cannot read.
    if (id !== undefined) return { selector: null };

    // The placeholders, `{owner}` or the older `:owner`, mean the current
    // repository, unless `GH_REPO` says which.
    if (/^(?:\{owner\}|:owner)$/.test(owner) && /^(?:\{repo\}|:repo)$/.test(repo)) {
      return env.GH_REPO === undefined ? { selector: [number] } : { selector: null };
    }
    // A literal repository is read by URL, so the pull request judged is the one
    // the path names rather than this repository's pull request of that number.
    return { selector: [`https://github.com/${owner}/${repo}/pull/${number}`] };
  }

  return null;
}

/** Every merge the command runs, in order. Empty when it runs none. */
export function mergeTargets(command) {
  return invocations(command).map(mergeOf).filter(Boolean);
}

/**
 * A GitHub MCP server's merge tool, which reaches the same endpoint as `gh api`,
 * under whatever name the server was registered with. `.claude/settings.json`
 * matches the same pattern.
 */
const MCP_MERGE_TOOL = /^mcp__.+__merge_pull_request$/;

const NAME = /^[A-Za-z0-9_.-]+$/;

/**
 * Every merge a PreToolUse payload makes: the commands of a Bash call, or the
 * one pull request the MCP merge tool names. An MCP call whose repository or
 * number cannot be read is `{ selector: null }`, the same unreadable merge a
 * `gh` command aimed elsewhere is.
 */
export function mergesIn(payload) {
  const tool = payload?.tool_name;
  if (typeof tool !== 'string' || !MCP_MERGE_TOOL.test(tool)) {
    return mergeTargets(payload?.tool_input?.command);
  }

  // The official github/github-mcp-server sends `pullNumber`; other servers and
  // the REST docs say `pull_number`.
  const { owner, repo, pullNumber, pull_number } = payload.tool_input ?? {};
  const number = pullNumber ?? pull_number;
  const readable =
    typeof owner === 'string' &&
    NAME.test(owner) &&
    typeof repo === 'string' &&
    NAME.test(repo) &&
    /^\d+$/.test(String(number));
  return [{ selector: readable ? [`https://github.com/${owner}/${repo}/pull/${number}`] : null }];
}

/**
 * When every `gh` read this hook makes has to be done: 15 seconds from start,
 * inside the 20 the hooks get in `hooks/hooks.json`. A hook that runs past
 * its timeout is treated as non-blocking, so a hung `gh` would let the merge
 * through `protect-merge.mjs`. Killed here, the read throws and each hook gives
 * its own answer to an unreadable pull request. One deadline rather than one
 * timeout per read, so a chained merge cannot add them up past 20.
 */
const DEADLINE = Date.now() + 15_000;

/**
 * Milliseconds left before the deadline, never below 1. Exported so
 * `require-canon.mjs` bounds its own git reads and its fetch by the same clock
 * rather than adding a timeout of its own per call.
 */
export const remaining = () => Math.max(1, DEADLINE - Date.now());
const timeout = remaining;

/** The fields both merge hooks read, renamed to the shape they were written against. */
const PR_FIELDS = '{baseRefName: .base.ref, number, url: .html_url}';

/**
 * The REST read for a `gh pr merge` selector: a number, a URL, a branch, or
 * nothing for the current branch. A branch is looked up among open pull requests
 * by head, the way `gh pr view` picks one.
 */
function prRead(selector) {
  const [target] = selector;
  const byHead = (head) => ({
    endpoint: `repos/{owner}/{repo}/pulls?head={owner}:${head}&state=open`,
    jq: `.[0] // empty | ${PR_FIELDS}`,
  });
  if (target === undefined) return byHead('{branch}');

  const url = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(target);
  if (url) return { endpoint: `repos/${url[1]}/${url[2]}/pulls/${url[3]}`, jq: PR_FIELDS };

  const number = /^#?(\d+)$/.exec(target);
  if (number) return { endpoint: `repos/{owner}/{repo}/pulls/${number[1]}`, jq: PR_FIELDS };

  return byHead(encodeURIComponent(target));
}

/**
 * The pull request a selector names, fetched once with the fields both callers
 * need.
 *
 * Two hooks call it. `protect-merge.mjs` reads every merge, to see whether its
 * base is `main`. `require-canon.mjs` reads an MCP merge, and a `gh pr merge` or
 * `gh pr ready` that names a pull request or runs from `staging` or `main`, to
 * find the pull request whose files it judges. `gh pr create` is not read here:
 * there is no pull request yet, so that hook diffs the branch locally.
 *
 * REST, not `gh pr view`: the same read takes a number, a URL or a branch, it
 * carries the URL `prFiles` needs to page the right repository, and it keeps
 * working in a Claude Code cloud session, which refuses GraphQL.
 *
 * On a merge both hooks run, and each used to shell out with its own field
 * list, which is two places for the `gh` invocation to drift. This is the one
 * invocation.
 *
 * It is deliberately not cached across the two processes. A file cache keyed by
 * pull request would collapse the pair into one call, and the saving is about a
 * second on an operation that happens a few times a day. `protect-merge.mjs` is
 * the gate on what ships into `main`, and a cached answer to "what is this pull
 * request's base branch" is a worse thing to own than the second it buys.
 *
 * `{ ok: false }` rather than a throw, because the two callers disagree about
 * what an unreadable pull request means and each has to decide for itself:
 * `protect-merge.mjs` fails closed, because a base it cannot see may be `main`;
 * `require-canon.mjs` fails open, because a missing canon line costs less than a
 * blocked pull request. A lookup by branch that finds no open pull request prints
 * nothing, and is unreadable too.
 */
export function prDetails(selector, { cwd, exec } = {}) {
  const run = exec ?? execFileSync;
  const { endpoint, jq } = prRead(selector);
  try {
    const raw = run('gh', ['api', endpoint, '--jq', jq], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeout(),
    });
    const pr = JSON.parse(raw);
    if (typeof pr?.baseRefName !== 'string' || !Number.isInteger(pr.number)) return { ok: false };
    return { ok: true, pr };
  } catch {
    return { ok: false };
  }
}

/**
 * Every path a pull request changes, paged. Only `require-canon.mjs` calls it, on
 * the pull request `prDetails` returned for an MCP merge or a `gh pr merge` or
 * `gh pr ready` it judges by pull request rather than by local diff.
 *
 * Not `gh pr view --json files`, which stops at 100 and made a large pull request
 * read as touching nothing governed. Not `gh pr diff --name-only` either: GitHub
 * refuses a diff over its size limit, and the large pull request this exists for
 * would fail open again. The files endpoint pages to 3,000.
 *
 * The repository comes from the pull request's own URL, so a merge read by URL
 * from another repository is judged on that pull request's files rather than on
 * this repository's pull request of the same number.
 */
export function prFiles(pr, { cwd, exec } = {}) {
  const run = exec ?? execFileSync;
  const [, owner = '{owner}', repo = '{repo}'] =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(pr.url ?? '') ?? [];
  try {
    const raw = run(
      'gh',
      [
        'api',
        '--paginate',
        // In the path, not `-F`, which would make the read a POST. GitHub's
        // default page is 30, and at that size a large pull request's reads run
        // past the hook's timeout, which lets the merge through unchecked.
        `repos/${owner}/${repo}/pulls/${pr.number}/files?per_page=100`,
        '--jq',
        '.[].filename',
      ],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: timeout() }
    );
    return { ok: true, paths: raw.split('\n').filter(Boolean) };
  } catch {
    return { ok: false };
  }
}
