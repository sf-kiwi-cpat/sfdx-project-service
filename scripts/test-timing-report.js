#!/usr/bin/env node

/**
 * Print the top-N slowest tests from a vitest JSON-reporter output file.
 *
 * Wired into every per-tier CI test job so the moment someone asks "why
 * is the suite slow?", the data is one click away in the most recent CI
 * run. Runs with `if: always()` — always emits the report even when the
 * test step itself failed, so a failing-and-also-slow test doesn't hide
 * the timing signal.
 *
 * Source of truth for the issue this implements: GitHub #248
 * (companion budget gate lands in part 2 once CI baselines accumulate).
 *
 * Usage:
 *   node scripts/test-timing-report.js [--input=<path>] [--top=<n>] [--tier=<name>]
 *
 *   --input  Path to vitest JSON output (default: test-results.json)
 *   --top    How many slowest tests to print     (default: 20)
 *   --tier   Optional label, included in the heading for clarity in CI logs
 *
 * The `--tier` flag is purely cosmetic — there is no per-tier logic in this
 * script. Each CI job calls it with its own tier name so the workflow log
 * reads "Top 20 slowest tests (spec)" instead of an unlabeled list.
 *
 * Input shape (vitest's `--reporter=json` output, Jest-compatible):
 *   {
 *     testResults: [
 *       {
 *         name: "<absolute file path>",
 *         assertionResults: [
 *           { fullName, title, duration /* ms *\/, status, ancestorTitles[] },
 *           ...
 *         ]
 *       },
 *       ...
 *     ]
 *   }
 *
 * We deliberately read per-test `duration` (assertion-level) rather than
 * file-level `startTime`/`endTime` deltas — the question this report is
 * meant to answer is "which individual tests are slow", not "which files
 * are slow". File-level aggregation hides a single 12s test inside a
 * suite of fast ones.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';

function parseArgs(argv) {
  const args = { input: 'test-results.json', top: 20, tier: null };
  for (const raw of argv.slice(2)) {
    const m = raw.match(/^--([a-zA-Z]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'input' && value) args.input = value;
    else if (key === 'top' && value) args.top = Number.parseInt(value, 10);
    else if (key === 'tier' && value) args.tier = value;
  }
  return args;
}

function formatMs(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(0)}ms`;
}

const { input, top, tier } = parseArgs(process.argv);
const inputPath = resolve(process.cwd(), input);

// Hard-fail on a missing input. The CI step that runs `--reporter=json
// --outputFile=test-results.json` is expected to produce the file every
// run; a missing file means the wiring upstream broke and silently
// skipping the report would mask that.
if (!existsSync(inputPath)) {
  console.error(`test-timing-report: input file not found: ${inputPath}`);
  process.exit(1);
}

let report;
try {
  report = JSON.parse(readFileSync(inputPath, 'utf8'));
} catch (err) {
  console.error(`test-timing-report: failed to parse ${inputPath}: ${err.message}`);
  process.exit(1);
}

const cwd = process.cwd();
const rows = [];

for (const file of report.testResults ?? []) {
  const filePath = file.name ? relative(cwd, file.name) : '<unknown file>';
  for (const test of file.assertionResults ?? []) {
    // Skip tests that didn't actually execute — pending/todo/skipped have
    // no meaningful duration. `duration` itself can also be null/undefined
    // in those cases; coerce defensively.
    if (test.status !== 'passed' && test.status !== 'failed') continue;
    const duration = Number(test.duration);
    if (!Number.isFinite(duration)) continue;
    rows.push({
      durationMs: duration,
      fullName: test.fullName || test.title || '<unnamed test>',
      file: filePath,
      status: test.status,
    });
  }
}

rows.sort((a, b) => b.durationMs - a.durationMs);
const topRows = rows.slice(0, top);

const heading = tier
  ? `Top ${top} slowest tests (${tier})`
  : `Top ${top} slowest tests`;

console.log(heading);
console.log('='.repeat(heading.length));

if (topRows.length === 0) {
  console.log('(no test timing data found)');
  process.exit(0);
}

// Right-align the duration column so the eye scans cleanly down it.
const widestDuration = Math.max(
  ...topRows.map((r) => formatMs(r.durationMs).length),
);
for (const row of topRows) {
  const dur = formatMs(row.durationMs).padStart(widestDuration);
  const marker = row.status === 'failed' ? ' [FAILED]' : '';
  console.log(`  ${dur}  ${row.fullName}${marker}`);
  console.log(`  ${' '.repeat(widestDuration)}  ${row.file}`);
}

const totalCounted = rows.length;
const cappedShown = topRows.length;
console.log('');
console.log(
  `(showing ${cappedShown} of ${totalCounted} executed tests with timing data)`,
);
