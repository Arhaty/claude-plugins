/**
 * The tracker rules the skills carry. A skill is prose, so these pin the text:
 * rewording is fine, and dropping a rule or a refusal fails here.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROLES } from '../hooks/lib/config.mjs';
import { SETTABLE } from '../scripts/tracker.mjs';
import { ROOT, describe, expect, it } from './helpers.mjs';

const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const skill = (name) => read(`skills/${name}/SKILL.md`);
const SKILLS = readdirSync(join(ROOT, 'skills'));

/** Every `set-state <ID> <role>` a skill names, as `[skill, role]`. */
const moves = SKILLS.flatMap((name) =>
  [...skill(name).matchAll(/set-state <ID> (\w+)/g)].map((match) => [name, match[1]])
);

describe('the tracker in the skills', () => {
  it('sends each skill that talks to it to the shared reference, which exists', () => {
    const reference = read('references/tracker.md');
    expect(reference).toMatch(/^# Working with the issue tracker/);
    for (const name of SKILLS) {
      // A skill that talks to the tracker, as opposed to one that only names it.
      if (!/<ID>|tracker\.mjs/.test(skill(name))) continue;
      expect(skill(name), name).toContain('${CLAUDE_PLUGIN_ROOT}/references/tracker.md');
    }
  });

  it('moves only the roles the client lets it, from the skills that own them', () => {
    const owners = {
      spec: ['define'],
      approved: ['approve'],
      building: ['build', 'ship'],
      blocked: ['build', 'ship'],
    };
    for (const [name, role] of moves) {
      expect(SETTABLE, `${name} sets ${role}`).toContain(role);
      expect(owners[role], `${name} sets ${role}`).toContain(name);
    }
    expect(SETTABLE.every((role) => ROLES.includes(role))).toBe(true);
    expect(moves.map(([name]) => name).sort()).toEqual([
      'approve',
      'build',
      'build',
      'build',
      'define',
      'ship',
      'ship',
    ]);
  });

  it('never sets a status from staging or production', () => {
    for (const name of ['staging', 'production']) {
      expect(skill(name), name).not.toMatch(/set-state/);
      expect(skill(name), name).toMatch(/never sets? (the issue's|an issue's) status/);
    }
  });

  it('refuses define on an issue not in ready, and build on one not approved', () => {
    expect(skill('define')).toMatch(/New spec: the role must be `ready`\./);
    expect(skill('build')).toMatch(/refuse unless the issue's role is `approved` or `blocked`/);
    expect(skill('ship')).toMatch(/the gate is the issue's role/);
  });

  it('approves on the tracker only after the push', () => {
    expect(skill('approve')).toMatch(/After the push and\s+never before/);
  });

  it('blocks with a marked comment, and asks in the chat as well', () => {
    for (const name of ['build', 'ship']) {
      const text = skill(name);
      expect(text, name).toContain('comment <ID> --blocked');
      expect(text, name).toContain('set-state <ID> blocked');
      expect(text, name).toMatch(/AskUserQuestion/);
      expect(text, name).toMatch(
        /answer in the chat\s+is posted on the issue, then `set-state <ID> building`/
      );
    }
  });

  it('resumes from the marker, never from who wrote a comment', () => {
    const reference = read('references/tracker.md');
    expect(reference).toMatch(/Never decide by who wrote a comment/);
    expect(reference).toMatch(/newest comment marked `canon: blocked`/);
    expect(reference).not.toMatch(/\bauthor\b/);
  });

  it('closes the issue from the pull request body and links it from commits', () => {
    expect(skill('build')).toMatch(
      /`Fixes <ID>` goes above it from the moment the pull request opens/
    );
    expect(skill('build')).toMatch(/`Part of <ID>`/);
    expect(skill('staging')).toMatch(/the pull request body does not close the issue/);
    expect(skill('production')).toMatch(/rebuild the `Fixes` block from the log every time/);
  });
});
