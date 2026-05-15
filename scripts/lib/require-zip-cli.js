#!/usr/bin/env node

/**
 * Pre-flight check for the system `zip` CLI.
 *
 * `scripts/zip-templates.js` and the `buildZip()` test helper in
 * `tests/unit/projects.test.ts` both shell out to `zip`. If `zip` is not
 * on PATH (minimal Docker images, fresh CI runners, Windows boxes
 * without Git-Bash/WSL) the underlying `execFileSync` surfaces a bare
 * `ENOENT` with no actionable hint. This helper probes once per process
 * with `zip -v` and, on failure, throws an Error whose message names
 * the missing binary and lists package-manager install commands.
 *
 * Idempotent: subsequent calls after the first successful probe are
 * no-ops, so multiple call sites can invoke it freely without
 * coordinating, and the actionable message is not printed twice when
 * both the build script and the test fixture builder run in the same
 * `npm test` invocation.
 *
 * Throws (rather than `process.exit(1)`) so the test runner surfaces
 * the message through the failed test rather than swallowing it via
 * vitest's stderr buffering — the build-script call site catches the
 * throw and exits, preserving its existing CLI behavior.
 */

import { execFileSync } from 'node:child_process';

let checked = false;

const MISSING_ZIP_MESSAGE =
  'the `zip` CLI is required to build templates but was not found on PATH.\n' +
  '  install via: apt-get install zip / brew install zip / choco install zip';

export function requireZipCli() {
  if (checked) return;
  try {
    execFileSync('zip', ['-v'], { stdio: 'ignore' });
  } catch {
    // Do NOT set `checked = true` on failure — a caller that catches
    // the error and retries (e.g. after fixing PATH) should be allowed
    // to re-probe. In practice no caller does this today, but the
    // alternative (silently passing on the second call after a failure)
    // would be worse.
    throw new Error(MISSING_ZIP_MESSAGE);
  }
  checked = true;
}

// Exported for tests — lets the unit suite reset the idempotency guard
// between cases without resorting to module-state hackery.
export function _resetForTesting() {
  checked = false;
}
