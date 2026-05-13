#!/usr/bin/env node

/**
 * Per-file coverage floor — fails CI when an individual `src/` file
 * falls below the floor on any metric.
 *
 * Why this exists (GitHub #239): vitest's aggregate threshold (90% on
 * main, 85% on feature branches) only checks the *average* across all
 * `src/**` files. A new under-covered file can hide in the average of
 * well-covered files — say, a 200-line route at 30% coverage that pulls
 * the aggregate from 92% to 91%, still over the gate. Per-file
 * thresholds catch exactly that regression.
 *
 * Why a script and not vitest's glob-keyed thresholds: vitest only
 * checks thresholds per-file when `coverage.thresholds.perFile` is
 * `true`, and that flag also applies the global aggregate numbers
 * (90%/85%) per-file — which trips on today's worst-covered file. A
 * separate, narrower per-file gate (with a lower floor than the
 * aggregate) is the cleanest way to keep the aggregate gate at 90%/85%
 * while adding a "no file is *terrible*" floor on top. Vitest's
 * `coverage-summary.json` reporter (already enabled) gives us the
 * per-file numbers; this script just reads it.
 *
 * Floor numbers were picked empirically: run `npm run test:coverage`
 * against `main`, take `min(observed per-file value)` per metric,
 * subtract 5pp, round to the nearest 5%. Numbers are metric-specific
 * because the report shows clear gaps (functions on `templates.ts`,
 * branches on `visualize.ts`) — applying the lowest single floor to
 * all metrics would defeat the gate for the higher-covered ones. The
 * point is to catch *new* under-covered files without retroactively
 * failing today's worst.
 *
 * Raising the floor over time is straightforward: rerun the
 * methodology and bump the constants below.
 *
 * Usage:
 *   node scripts/check-per-file-coverage.js [--input=<path>]
 *
 *   --input  Path to vitest's coverage-summary.json
 *            (default: coverage/coverage-summary.json)
 *
 * Exit codes:
 *   0 — every collected `src/` file meets the floor on every metric
 *   1 — at least one file falls below; offending files printed to stderr
 *   2 — input file missing or malformed (likely coverage didn't run)
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PER_FILE_FLOOR = {
  lines: 75,
  branches: 60,
  functions: 45,
  statements: 75,
};

const METRICS = Object.keys(PER_FILE_FLOOR);

const args = process.argv.slice(2);
const inputArg = args.find((a) => a.startsWith('--input='));
const inputPath = inputArg ? inputArg.slice('--input='.length) : 'coverage/coverage-summary.json';

let summary;
try {
  summary = JSON.parse(readFileSync(resolve(inputPath), 'utf8'));
} catch (err) {
  console.error(`[per-file-coverage] could not read ${inputPath}: ${err.message}`);
  console.error('[per-file-coverage] did `npm run test:coverage` finish? json-summary reporter must be enabled in vitest.config.ts.');
  process.exit(2);
}

// `coverage-summary.json` is { [absolutePath]: { lines: { pct, ... }, ... }, total: {...} }
// We only floor `src/` files; vitest's `include`/`exclude` config decides
// which files appear here in the first place (e.g. `src/index.ts` is
// excluded above), so we just iterate whatever's present and skip the
// `total` aggregate row.
const cwd = process.cwd();
const failures = [];

for (const [key, fileSummary] of Object.entries(summary)) {
  if (key === 'total') continue;
  const relPath = key.startsWith(cwd) ? key.slice(cwd.length + 1) : key;
  // Only check files under `src/`. Tests, scripts, and template
  // sources are out of scope for this gate.
  if (!relPath.startsWith('src/') && !relPath.startsWith('src\\')) continue;

  for (const metric of METRICS) {
    const observed = fileSummary[metric]?.pct;
    const floor = PER_FILE_FLOOR[metric];
    if (typeof observed !== 'number') continue;
    if (observed < floor) {
      failures.push({ file: relPath, metric, observed, floor });
    }
  }
}

if (failures.length === 0) {
  // Quiet on success — keeps CI logs clean. The aggregate `text`
  // reporter already shows the per-file numbers above this script's
  // output.
  process.exit(0);
}

console.error('');
console.error('[per-file-coverage] Per-file coverage floor not met:');
console.error('');
for (const { file, metric, observed, floor } of failures) {
  console.error(`  ${file}: ${metric} ${observed}% < ${floor}% floor`);
}
console.error('');
console.error('[per-file-coverage] Add tests for the affected file(s), or — if the');
console.error('[per-file-coverage] floor genuinely no longer matches the codebase\'s');
console.error('[per-file-coverage] worst — re-baseline by editing PER_FILE_FLOOR in');
console.error('[per-file-coverage] scripts/check-per-file-coverage.js.');
console.error('');
process.exit(1);
