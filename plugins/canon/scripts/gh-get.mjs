#!/usr/bin/env node
/**
 * Read one GitHub REST endpoint through `gh api`, and nothing else, so a skill can
 * pre-approve its reads without approving `gh api` writes along with them.
 *
 *   node gh-get.mjs <endpoint> [--paginate] [--jq <expression>]
 *
 * The method is always GET. A field, a header, an input or any other flag is
 * refused rather than passed on: with `-f`, `gh api` sends a POST. GraphQL is
 * refused too, as a cloud session's proxy does. `{owner}`, `{repo}` and `{branch}`
 * are left for `gh api` to fill in from the checkout.
 */

import { spawnSync } from 'node:child_process';

function parse(args) {
  let endpoint;
  const passed = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--paginate') passed.push(arg);
    else if (arg === '--jq' && i + 1 < args.length) passed.push(arg, args[++i]);
    else if (arg.startsWith('--jq=')) passed.push(arg);
    else if (!arg.startsWith('-') && endpoint === undefined) endpoint = arg;
    else return { error: `\`${arg}\` is not a read: only an endpoint, --paginate and --jq` };
  }
  if (endpoint === undefined) return { error: 'name an endpoint' };
  if (/(?:^|\/)graphql(?:[/?]|$)/.test(endpoint)) return { error: 'GraphQL is not a REST read' };
  return { argv: ['api', '--method', 'GET', endpoint, ...passed] };
}

const parsed = parse(process.argv.slice(2));
if (parsed.error) {
  process.stderr.write(
    `canon: gh-get ${parsed.error}.\nUsage: gh-get.mjs <endpoint> [--paginate] [--jq <expr>]\n`
  );
  process.exitCode = 2;
} else {
  const result = spawnSync('gh', parsed.argv, { stdio: 'inherit' });
  if (result.error) {
    process.stderr.write(`canon: could not run gh: ${result.error.message}\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}
