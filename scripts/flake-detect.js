#!/usr/bin/env node

/**
 * Run the full vitest suite N times back-to-back and aggregate per-test
 * outcomes to surface flaky tests — tests that did not pass uniformly
 * across identical runs against the same source tree.
 *
 * Source of truth for the issue this implements: GitHub #245.
 *
 * Why repeat-run sampling (and not CI history mining): mining requires
 * CI to retry on failure, and `ci.yml` currently doesn't. Repeat-run is
 * deterministic, doesn't change CI behavior, and yields a clean per-test
 * pass count (`17/20 passed`) rather than a fuzzy "failed once last week".
 *
 * Why N=20: catches ~5% flakes in one run with high probability, and the
 * weekly schedule will surface rarer ones over time. Higher N has
 * diminishing returns; lower N misses too many real flakes.
 *
 * Why we invoke the vitest binary directly (not `npm test`): `npm test`
 * fires the `pretest: npm run build:templates` hook on every iteration.
 * That's load-bearing on the first run (templates/dist/ must exist) but
 * wasted work on the other 19. The workflow runs the build once before
 * the loop, so subsequent runs find templates/dist/ already populated.
 *
 * Output:
 *   reports/flake/run-1.json … run-N.json   (raw vitest JSON per run)
 *   reports/flake/summary.json              (aggregated per-test counts)
 *
 * Exit code:
 *   0 — every test passed in every run (no flakes detected)
 *   1 — at least one test failed in at least one run, OR a run failed
 *       to produce parsable output (treated as a failure to surface
 *       infrastructure breakage rather than masking it)
 *
 * Usage:
 *   node scripts/flake-detect.js [--runs=<n>] [--out=<dir>]
 *
 *   --runs   How many full-suite iterations to execute. Default: 20.
 *   --out    Directory for per-run logs and summary.json.
 *            Default: reports/flake.
 *
 * The script keeps going past a failing run — flake detection is
 * meaningless if we bail on the first non-zero exit. Every failure
 * counts as a data point against the offending tests.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

function parseArgs(argv) {
  const args = { runs: 20, out: 'reports/flake' };
  for (const raw of argv.slice(2)) {
    const m = raw.match(/^--([a-zA-Z]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'runs' && value) args.runs = Number.parseInt(value, 10);
    else if (key === 'out' && value) args.out = value;
  }
  if (!Number.isFinite(args.runs) || args.runs < 1) {
    console.error(`flake-detect: --runs must be a positive integer, got ${args.runs}`);
    process.exit(2);
  }
  return args;
}

const { runs, out } = parseArgs(process.argv);
const cwd = process.cwd();
const outDir = resolve(cwd, out);
const vitestBin = resolve(cwd, 'node_modules', '.bin', 'vitest');

if (!existsSync(vitestBin)) {
  console.error(`flake-detect: vitest binary not found at ${vitestBin}`);
  console.error('  did you run `npm ci` first?');
  process.exit(2);
}

// Wipe and recreate the output directory so a re-run on the same machine
// (workflow_dispatch debugging) doesn't mix this run's logs with the
// previous one's. The summary aggregates *only* what's on disk this run.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

/**
 * Aggregated per-test counts.
 *
 * Key shape: `<file path relative to cwd>:<full assertion name>`. Full
 * names include the surrounding describe() chain so two tests with the
 * same `it()` title in different files (or different blocks) don't
 * collide. Vitest's JSON reporter emits `fullName` already in this form.
 *
 * Value shape: { passed, failed, skipped, lastFailure }.
 *   - passed/failed counts are summed across the N runs
 *   - skipped is informational; we don't flag a test as flaky for
 *     toggling between skipped and ran (that's an authoring change, not
 *     a flake)
 *   - lastFailure captures the most recent failure message + run index
 *     so the issue body can show a representative excerpt without
 *     attaching all 20 logs
 */
const counts = new Map();

function recordTest(filePath, test, runIndex) {
  // Skip pending/todo — they have no meaningful outcome.
  if (test.status !== 'passed' && test.status !== 'failed' && test.status !== 'skipped') {
    return;
  }
  const fullName = test.fullName || test.title || '<unnamed test>';
  const key = `${filePath}::${fullName}`;
  let entry = counts.get(key);
  if (!entry) {
    entry = {
      file: filePath,
      fullName,
      passed: 0,
      failed: 0,
      skipped: 0,
      lastFailure: null,
    };
    counts.set(key, entry);
  }
  if (test.status === 'passed') entry.passed += 1;
  else if (test.status === 'skipped') entry.skipped += 1;
  else if (test.status === 'failed') {
    entry.failed += 1;
    const messages = Array.isArray(test.failureMessages) ? test.failureMessages : [];
    const firstLine = messages[0]?.split('\n')[0] ?? 'failed';
    entry.lastFailure = { run: runIndex, message: firstLine };
  }
}

function ingestRun(runIndex, reportPath) {
  if (!existsSync(reportPath)) {
    console.error(`flake-detect: run ${runIndex}: missing report file ${reportPath}`);
    return false;
  }
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (err) {
    console.error(`flake-detect: run ${runIndex}: failed to parse ${reportPath}: ${err.message}`);
    return false;
  }
  for (const file of report.testResults ?? []) {
    const filePath = file.name ? relative(cwd, file.name) : '<unknown file>';
    for (const test of file.assertionResults ?? []) {
      recordTest(filePath, test, runIndex);
    }
  }
  return true;
}

let infrastructureFailures = 0;

for (let i = 1; i <= runs; i += 1) {
  const reportPath = join(outDir, `run-${i}.json`);
  console.error(`flake-detect: run ${i}/${runs} → ${relative(cwd, reportPath)}`);
  // Run vitest directly. `--reporter=json` emits the Jest-compatible
  // JSON shape we ingest below; we keep the default reporter off to
  // avoid duplicate console noise.
  const result = spawnSync(
    vitestBin,
    ['run', '--reporter=json', `--outputFile=${reportPath}`],
    {
      cwd,
      stdio: ['ignore', 'inherit', 'inherit'],
      // Don't fail the script on a non-zero exit — vitest exits 1 when
      // any test fails, which is exactly the case we want to study.
      shell: false,
    }
  );
  // A signal/crash means we have no JSON to ingest at all. Log and move
  // on — every run that produced no parsable data counts against the
  // overall verdict so infra breakage doesn't silently produce a
  // green report.
  if (result.error) {
    console.error(`  spawn error: ${result.error.message}`);
  }
  const ingested = ingestRun(i, reportPath);
  if (!ingested) infrastructureFailures += 1;
}

// Build the summary. Flakes are tests with at least one passed AND at
// least one failed across the runs (genuine non-uniformity). A test
// that failed on every run isn't flaky — it's broken. We still include
// always-failed tests in `summary.json` under a separate key so the
// reviewer can spot them, but they don't count as flakes for the main
// verdict; the regular CI gate will surface broken tests directly.
const flakes = [];
const alwaysFailed = [];
for (const entry of counts.values()) {
  if (entry.failed > 0 && entry.passed > 0) flakes.push(entry);
  else if (entry.failed > 0 && entry.passed === 0) alwaysFailed.push(entry);
}

flakes.sort((a, b) => {
  // Highest failure rate first; tie-break by file then test name for
  // stable output across runs.
  if (b.failed !== a.failed) return b.failed - a.failed;
  if (a.file !== b.file) return a.file.localeCompare(b.file);
  return a.fullName.localeCompare(b.fullName);
});

const summary = {
  generatedAt: new Date().toISOString(),
  runs,
  infrastructureFailures,
  totalTests: counts.size,
  flakeCount: flakes.length,
  alwaysFailedCount: alwaysFailed.length,
  flakes,
  alwaysFailed,
};

const summaryPath = join(outDir, 'summary.json');
mkdirSync(dirname(summaryPath), { recursive: true });
writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');

console.error('');
console.error(`flake-detect: ${runs} runs complete`);
console.error(`  total distinct tests observed: ${counts.size}`);
console.error(`  flaky tests:                   ${flakes.length}`);
console.error(`  always-failed tests:           ${alwaysFailed.length}`);
console.error(`  runs with infra failure:       ${infrastructureFailures}`);
console.error(`  summary:                       ${relative(cwd, summaryPath)}`);

if (flakes.length > 0) {
  console.error('');
  console.error('Flaky tests:');
  for (const f of flakes) {
    console.error(`  ${f.passed}/${runs} passed  ${f.file} > ${f.fullName}`);
  }
}

// Exit non-zero on any flake OR any infra failure. The workflow keys
// the "file issue" step on `if: failure()`, so this is the only way
// we can signal "please file an issue" to the next workflow step.
const hasFlakes = flakes.length > 0;
const hasInfraFailure = infrastructureFailures > 0;
process.exit(hasFlakes || hasInfraFailure ? 1 : 0);
