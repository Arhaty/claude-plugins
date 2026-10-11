import { CMD_START, GIT, commandSkeleton } from './merge-command.mjs';

/**
 * Does this Bash command write something? A list of shapes, not a shell parser.
 *
 * `protect-branch.mjs` guards Edit and Write, and that is not where a guard gets
 * walked past: a session told to prefer Bash edits with a heredoc, `sed -i` or an
 * inline `node -e` script, and a hook watching only the file tools never sees any
 * of it. Many setups ask for exactly that Bash-first style, so covering it is
 * not optional.
 *
 * Shared rather than inlined so it can be tested, which matters more here than in
 * most hooks: a false positive blocks legitimate work on a protected branch and a
 * blocked hook gets bypassed out of habit. Wrong in both directions occasionally
 * is the accepted cost, and the refusal names the bypass in the same breath.
 */

/**
 * Writes that cannot be confined to a scratch path, so the target is not worth
 * inspecting: an in-place edit names the file it rewrites, and `git commit` writes
 * the repository itself.
 */
const ALWAYS = [
  /\btee\b/,
  /\bsed\s+(-[a-z]*\s+)*-[a-z]*i/,
  /\bperl\s+.*-[a-z]*i/,
  /\b(python3?|node)\s+(-c|-e|-)(\s|$)/,
  // `GIT` rather than a bare `git`, so a global option before the subcommand does
  // not hide it. `git -c user.name=x commit` is how this repository's own commits
  // are made, and the guard could not see a single one of them.
  new RegExp(`\\b${GIT}\\s+(commit|apply|am|mv|rm|restore|revert|cherry-pick|rebase|merge)\\b`),
  new RegExp(`\\b${GIT}\\s+checkout\\s+--`),
  new RegExp(`\\b${GIT}\\s+stash\\s+(pop|apply)\\b`),
];

/**
 * Verbs whose operands are the files they write, so a command that only touches
 * scratch paths writes nothing this hook protects.
 *
 * Matched anywhere rather than only at a command position, so `xargs rm` and
 * `find -exec rm` still trip it. `(\s|$)` rather than `\s`: a verb at the very end
 * of the string has no trailing space, so `xargs rm` would otherwise pass while
 * `xargs rm ` does not, which is the same accident that let `pnpm install` through.
 */
const PATH_VERB = /\b(mv|cp|rm|touch|truncate|ln|mkdir)(\s|$)/;

/**
 * BSD `install`, which copies a file into place, and the one write verb that is also
 * a package-manager subcommand. It stays out of `PATH_VERB` and keeps its own
 * command-position anchor, because matching it anywhere refuses
 * `pnpm install --frozen-lockfile`, the first thing CI runs, and a read as far as
 * the repository's tracked tree is concerned.
 */
const INSTALL = new RegExp(`${CMD_START}install(\\s|$)`);

/**
 * A scratch path: a workspace rather than this repository's tracked content.
 *
 * **`tmp/` at the repository root is on this list.** It is the conventional
 * gitignored scratch directory, where dev servers keep logs and markers. Without it,
 * starting a server to look at a protected branch was refused, and the refusal said
 * to make a feature branch, which is not the problem and does not fix it.
 *
 * `/dev/null` is not a write by any reading.
 */
const SAFE_TARGET = /^(\/dev\/null|\/tmp\/|\/private\/tmp\/|\$TMPDIR|\.?\/?tmp\/|\.?\/?tmp$)/;

export function writesToWorktree(command) {
  if (typeof command !== 'string' || command.length === 0) return false;

  // **The two halves read two different skeletons, and the difference is the point.**
  //
  // A verb is looked for with quoted spans dropped, because there the quoted text is
  // data rather than a command: `grep -rn "rm -rf" docs/` runs no `rm` and
  // `echo "see the mv section"` moves nothing. Matching the raw string blocked both
  // on a protected branch.
  //
  // A redirect target is read with quoted spans kept, because the target is a value:
  // `git log > "/tmp/a.txt"` writes to the scratch path it names, and dropping the
  // quotes hid that path and called an ordinary read a repository write. Keeping the
  // text is safe for the opposite case too, since a `>` *inside* quotes is defused
  // by the skeleton, so `awk '$1 > 2' data.txt` still holds no redirect.
  const verbs = commandSkeleton(command, { quoted: 'drop' });
  if (ALWAYS.some((pattern) => pattern.test(verbs))) return true;
  if (INSTALL.test(verbs)) return true;

  // A path verb writes what its operands name, so a segment whose operands are all
  // scratch writes nothing here. Judged per segment rather than over the whole
  // command, so `mkdir -p tmp && rm src/x.ts` is still a write: the second segment
  // names a tracked path even though the first does not.
  //
  // **The verb is read from one skeleton and its operands from the other**, and that
  // split is the whole correctness of this block. Reading operands from the
  // quote-dropped skeleton makes a quoted target vanish, the "no operands" guard
  // then fires, and `touch "tmp/.marker"` is called a repository write, which is the
  // regression the comment on SAFE_TARGET describes.
  //
  // The two skeletons are the same length and differ only inside quoted spans, so a
  // split on the same separators yields segments that line up by index.
  const values = commandSkeleton(command);
  const SEGMENT = /;|&&|\|\||\||\n/;
  const verbSegments = verbs.split(SEGMENT);
  const valueSegments = values.split(SEGMENT);

  for (const [index, segment] of verbSegments.entries()) {
    if (!PATH_VERB.test(segment)) continue;

    const words = (valueSegments[index] ?? '').trim().split(/\s+/).filter(Boolean);
    const verbAt = words.findIndex((word) => PATH_VERB.test(word + ' '));
    const operands = words.slice(verbAt + 1).filter((word) => !word.startsWith('-'));

    // No operands at all is `xargs rm`, where the paths arrive on stdin and cannot
    // be judged from here. Refuse rather than guess.
    if (operands.length === 0) return true;

    // An operand carrying a substitution cannot be resolved, so it is not known to be
    // scratch. Refusing is the safe direction; write a repo-relative path instead.
    if (operands.some((operand) => /[$`]/.test(operand))) return true;

    if (!operands.every((operand) => SAFE_TARGET.test(operand))) return true;
  }

  // `2>&1` duplicates a descriptor and writes nothing. Strip those first, then
  // every remaining `>` or `>>` has a real target to judge.
  const redirects = commandSkeleton(command)
    .replace(/\d?>&\d/g, '')
    .matchAll(/>>?\s*(\S+)/g);
  for (const [, raw] of redirects) {
    if (!SAFE_TARGET.test(raw)) return true;
  }
  return false;
}
