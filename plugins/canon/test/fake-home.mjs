/**
 * Test-only preload: points `os.userInfo().homedir` at `$CANON_TEST_HOME`, so a hook
 * run as a child process reads and writes a scratch trust file rather than the
 * developer's own `~/.claude/canon/trusted.json`. The plugin reads the account's
 * home rather than `$HOME` on purpose, so setting `$HOME` is not enough.
 *
 * Loaded with `--import`, through `run(..., { home })` in `helpers.mjs`. Standalone,
 * so a hook process never loads `node:test`.
 */

import { createRequire, syncBuiltinESMExports } from 'node:module';

const home = process.env.CANON_TEST_HOME;
if (home) {
  const os = createRequire(import.meta.url)('node:os');
  const real = os.userInfo;
  os.userInfo = (options) => ({ ...real(options), homedir: home });
  syncBuiltinESMExports();
}
