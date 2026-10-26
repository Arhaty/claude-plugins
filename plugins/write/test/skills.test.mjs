/**
 * What a skill pre-approves. A grant in `allowed-tools` runs without a prompt, so each one is
 * a reviewed entry here: a new grant fails until it is added, and a broad one is refused.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SKILLS = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');

/** Every `allowed-tools` entry, inline or a YAML list, with quotes stripped. */
function grants(markdown) {
  const lines = markdown.split(/\n---\n/)[0].split('\n');
  const at = lines.findIndex((line) => line.startsWith('allowed-tools:'));
  if (at === -1) return [];
  const inline = lines[at].slice('allowed-tools:'.length).trim();
  const items = inline
    ? inline.split(',')
    : lines
        .slice(at + 1)
        .filter((line) => !/^\s*(#.*)?$/.test(line))
        .map((line) => line.match(/^\s*-\s+(.*)$/)?.[1])
        .filter((item, i, all) => item !== undefined && all.slice(0, i).every(Boolean));
  return items.map((item) => item.trim().replace(/^(['"])(.*)\1$/, '$2')).filter(Boolean);
}

// `scaffold.mjs plan` only reads; `apply` writes the project, so it is left to prompt.
const ALLOWED = [
  'Bash(git rev-parse --show-toplevel)',
  'Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/scaffold.mjs" plan *)',
  'Read',
  'Grep',
  'Glob',
  'AskUserQuestion',
];

describe('skills pre-approve only listed, scoped tools', () => {
  const names = readdirSync(SKILLS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const name of names) {
    it(`${name} grants only listed tools`, () => {
      const markdown = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8');
      for (const grant of grants(markdown)) assert.ok(ALLOWED.includes(grant), grant);
    });
  }

  for (const front of [
    'allowed-tools: Bash, Read',
    'allowed-tools: Read, Write',
    'allowed-tools:\n  - Read\n  - Bash(node *)',
    'allowed-tools:\n  - Read\n  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/scaffold.mjs" *)',
    'allowed-tools:\n  - Read\n  - Edit',
  ]) {
    it(`refuses ${JSON.stringify(front)}`, () => {
      const found = grants(`---\nname: x\n${front}\n---\n`);
      assert.ok(found.length > 1, 'the grants were read');
      assert.ok(
        found.some((grant) => !ALLOWED.includes(grant)),
        'a broad grant passed'
      );
    });
  }
});
