/**
 * What `extract` carries from a canon file into the index: claims and table rows,
 * and nothing that only illustrates one.
 */

import { extract } from '../scripts/canon-index.mjs';
import { describe, expect, it } from './helpers.mjs';

describe('extract', () => {
  it('carries a claim and a table row', () => {
    expect(extract('x.md', '- **A claim.** Why.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n')).toEqual([
      'x.md: **A claim.** Why.',
      'x.md: | a | b |',
      'x.md: | 1 | 2 |',
    ]);
  });

  it('carries nothing from inside a backtick fence', () => {
    const source = '```\n| a | b |\n**Status.** example\n```\n**A claim.** Why.\n';
    expect(extract('x.md', source)).toEqual(['x.md: **A claim.** Why.']);
  });

  it('carries nothing from inside a tilde or indented fence', () => {
    const source = '  ~~~md\n- **Example.** Not a rule.\n  ~~~\n- **A claim.** Why.\n';
    expect(extract('x.md', source)).toEqual(['x.md: **A claim.** Why.']);
  });

  it('reads claims again after a fence closes', () => {
    const source = '**Before.**\n```js\nconst a = 1;\n```\n**After.**\n';
    expect(extract('x.md', source)).toEqual(['x.md: **Before.**', 'x.md: **After.**']);
  });
});
