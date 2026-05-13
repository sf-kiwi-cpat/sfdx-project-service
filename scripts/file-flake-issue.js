#!/usr/bin/env node

/**
 * Read reports/flake/summary.json and file (or update) one tracking
 * issue per ISO week listing the flaky tests detected.
 *
 * Source of truth for the issue this implements: GitHub #245.
 *
 * Why one issue per ISO week (not per run): the workflow runs weekly
 * on Monday but is also `workflow_dispatch`able for ad-hoc verification.
 * Multiple dispatches in the same week should refresh the same issue,
 * not spawn duplicates that humans then have to dedupe by hand. Using
 * the ISO-week Monday in the title gives a stable, sortable key without
 * needing any per-issue state.
 *
 * Why DRY_RUN exists: per the issue's two-PR landing plan, the first
 * PR ships the workflow without auto-filing so we can inspect the
 * generated body on a real `ubuntu-latest` run before letting it post.
 * `DRY_RUN=true` prints the would-be issue body to stdout and exits 0.
 * The follow-up PR flips DRY_RUN to false (or removes it) in the
 * workflow YAML.
 *
 * Repository discovery: prefers GITHUB_REPOSITORY (set automatically in
 * GitHub Actions). Locally, falls back to parsing `git remote get-url
 * origin`. Either way the script needs a real `gh` invocation against
 * an authenticated runner to actually file an issue, so this is mainly
 * a sanity check before we shell out.
 *
 * Output:
 *   stdout — informational log lines (and the rendered body in dry-run)
 *   stderr — diagnostics on bad summary, missing gh, etc.
 *
 * Exit code:
 *   0 — issue filed/updated successfully, or DRY_RUN=true succeeded,
 *       or no flakes were found (nothing to file)
 *   1 — anything else (invalid summary, gh failure, etc.)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SUMMARY_PATH = resolve(process.cwd(), 'reports/flake/summary.json');
const DRY_RUN = String(process.env.DRY_RUN ?? '').toLowerCase() === 'true';

if (!existsSync(SUMMARY_PATH)) {
  console.error(`file-flake-issue: summary not found at ${SUMMARY_PATH}`);
  console.error('  did flake-detect.js run first?');
  process.exit(1);
}

let summary;
try {
  summary = JSON.parse(readFileSync(SUMMARY_PATH, 'utf8'));
} catch (err) {
  console.error(`file-flake-issue: failed to parse ${SUMMARY_PATH}: ${err.message}`);
  process.exit(1);
}

const flakes = Array.isArray(summary.flakes) ? summary.flakes : [];
const alwaysFailed = Array.isArray(summary.alwaysFailed) ? summary.alwaysFailed : [];
const runs = Number.isFinite(summary.runs) ? summary.runs : 0;
const infrastructureFailures = Number.isFinite(summary.infrastructureFailures)
  ? summary.infrastructureFailures
  : 0;

if (flakes.length === 0 && alwaysFailed.length === 0 && infrastructureFailures === 0) {
  console.log('file-flake-issue: no flakes, no always-failed, no infra failures — nothing to file');
  process.exit(0);
}

/**
 * ISO-week Monday in UTC, formatted YYYY-MM-DD.
 *
 * The week boundary in the issue title needs to be deterministic across
 * runners and time zones. ISO-8601 defines weeks as Monday-Sunday with
 * the week containing the year's first Thursday counted as week 1 — so
 * we compute "Monday of the current ISO week" by shifting back to
 * Monday in UTC. `Date#getUTCDay()` returns 0 (Sunday) through 6
 * (Saturday); we map Sunday to 7 so subtracting `(day - 1)` lands on
 * the preceding Monday for every other day of the week as well.
 *
 * Boundary note (intentional, not a bug): ISO-8601 treats Sunday as the
 * last day of the week that started on the *prior* Monday. So a run at
 * 23:59 UTC on Sunday and a run at 08:00 UTC on the following Monday
 * compute *different* `weekStamp` values — Sunday lands on the prior
 * Monday, Monday lands on itself — and a `workflow_dispatch` straddling
 * that boundary can spawn two issues for what a human might call "this
 * week's flakes." The cadence is weekly and the regular schedule is
 * Monday morning UTC, so drift is rare in practice; if it ever bites,
 * collapse the duplicates manually rather than reach for a non-ISO
 * boundary here. Equivalent formulations like
 * `(date.getUTCDay() + 6) % 7` produce identical results — the boundary
 * is a property of ISO-8601 itself, not of this implementation.
 */
function isoWeekMondayUTC(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (day - 1));
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

const weekStamp = isoWeekMondayUTC();
const title = `[flake-detection] Flaky tests detected — week of ${weekStamp}`;

function groupByFile(entries) {
  const groups = new Map();
  for (const e of entries) {
    if (!groups.has(e.file)) groups.set(e.file, []);
    groups.get(e.file).push(e);
  }
  // Sort files for stable output, and tests within each file by failure
  // count desc → name asc.
  const sortedKeys = Array.from(groups.keys()).sort();
  const out = [];
  for (const file of sortedKeys) {
    const tests = groups.get(file).sort((a, b) => {
      if (b.failed !== a.failed) return b.failed - a.failed;
      return a.fullName.localeCompare(b.fullName);
    });
    out.push({ file, tests });
  }
  return out;
}

function escapeBackticks(s) {
  // Failure messages may contain inline `code spans`; keep them readable
  // inside the markdown bullet by escaping any stray backticks. This is
  // good enough — we're showing one short line, not full stack traces.
  return String(s).replace(/`/g, '\\`');
}

function renderBody() {
  const lines = [];
  lines.push(`Generated by \`scripts/flake-detect.js\` — see [GitHub #245](https://github.com/forcedotcom/sfdx-project-service/issues/245).`);
  lines.push('');
  lines.push(`Detection window: ISO week starting **${weekStamp} (Monday, UTC)**.`);
  lines.push(`Runs in this batch: **${runs}**.`);
  lines.push(`Last detection: ${summary.generatedAt}.`);
  lines.push('');

  if (infrastructureFailures > 0) {
    lines.push(`> Note: ${infrastructureFailures} of the ${runs} runs failed to produce parsable results (the runner crashed, vitest spawn errored, or the JSON output was malformed). Counts below are aggregated only across runs that produced output, so the denominator effectively shrinks for affected tests. If this number is high, the flake report itself is unreliable for this week.`);
    lines.push('');
  }

  if (flakes.length === 0) {
    lines.push('No flaky tests were detected this week.');
  } else {
    lines.push(`## Flaky tests (${flakes.length})`);
    lines.push('');
    lines.push('A test is "flaky" if it passed at least once AND failed at least once across the runs in this batch — same source tree, same machine, different outcome.');
    lines.push('');
    for (const group of groupByFile(flakes)) {
      lines.push(`### \`${group.file}\``);
      lines.push('');
      for (const t of group.tests) {
        const passRate = `${t.passed}/${runs} passed`;
        lines.push(`- **${t.fullName}** — ${passRate}`);
        if (t.lastFailure?.message) {
          lines.push(`  - run ${t.lastFailure.run}: \`${escapeBackticks(t.lastFailure.message)}\``);
        }
      }
      lines.push('');
    }
  }

  if (alwaysFailed.length > 0) {
    lines.push(`## Tests that failed in every run (${alwaysFailed.length})`);
    lines.push('');
    lines.push('These are not flaky — they failed deterministically on every run. The regular CI gate should already be surfacing them; listed here only so the picture is complete.');
    lines.push('');
    for (const group of groupByFile(alwaysFailed)) {
      lines.push(`### \`${group.file}\``);
      lines.push('');
      for (const t of group.tests) {
        lines.push(`- **${t.fullName}** — 0/${runs} passed`);
        if (t.lastFailure?.message) {
          lines.push(`  - run ${t.lastFailure.run}: \`${escapeBackticks(t.lastFailure.message)}\``);
        }
      }
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push('## What to do');
  lines.push('');
  lines.push('Pick one per test:');
  lines.push('');
  lines.push('1. **Fix it.** Find the race / time-dependence / order-dependence and remove the source of nondeterminism.');
  lines.push('2. **Quarantine it.** Mark `.skip` with a TODO and a tracking issue. Treat as tech debt — review weekly.');
  lines.push('3. **Delete it.** If the test is more trouble than it\'s worth, remove it rather than leaving it skipped indefinitely.');
  lines.push('');
  lines.push('Do not "just retry CI". The flake will keep biting until it\'s addressed at the source.');
  lines.push('');
  lines.push('Per-run JSON logs are attached as a workflow artifact (30-day retention) — open the most recent `flake-detection` run in Actions to download them.');
  lines.push('');
  lines.push('_This issue is auto-updated by the weekly `flake-detection` workflow. A new issue is opened each ISO week; manual edits inside this body will be overwritten on the next dispatch in the same week._');

  return lines.join('\n');
}

const body = renderBody();

if (DRY_RUN) {
  console.log('--- DRY RUN: not filing or updating any issue ---');
  console.log(`title: ${title}`);
  console.log('---');
  console.log(body);
  console.log('--- end DRY RUN ---');
  process.exit(0);
}

// Resolve the repo. Prefer the env var that GitHub Actions sets; fall
// back to git remote parsing for ad-hoc local invocations.
function resolveRepo() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    // Match git@github.com:owner/repo(.git)? OR https://github.com/owner/repo(.git)?
    const m = url.match(/[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

const repo = resolveRepo();
if (!repo) {
  console.error('file-flake-issue: could not determine repo (GITHUB_REPOSITORY unset, git remote missing)');
  process.exit(1);
}

function gh(args, options = {}) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...options,
  });
}

// Search for an existing issue for this week. We use the search API
// (not `gh issue list --search`) because the search index lets us scope
// to title-only matches reliably. The dedup key is the literal week
// stamp in the title — see CLAUDE.md "gh issue list" gotcha for why we
// avoid `--label` and similar filters.
let existingNumber = null;
try {
  const found = gh([
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--search',
    `in:title "[flake-detection] Flaky tests detected — week of ${weekStamp}"`,
    '--json',
    'number,title',
    '--limit',
    '5',
  ]);
  const matches = JSON.parse(found).filter((i) => i.title === title);
  if (matches.length > 0) existingNumber = matches[0].number;
} catch (err) {
  console.error(`file-flake-issue: gh search failed: ${err.message}`);
  process.exit(1);
}

// Pass the body via stdin to avoid the markdown-`#`-in-arg-string
// permission-matcher issue called out in CLAUDE.md. `gh issue create`
// and `gh issue edit` both accept `--body-file -`.
function ghWithStdinBody(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    input: body,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
}

if (existingNumber) {
  console.log(`file-flake-issue: updating existing issue #${existingNumber}`);
  ghWithStdinBody([
    'issue',
    'edit',
    String(existingNumber),
    '--repo',
    repo,
    '--body-file',
    '-',
  ]);
  console.log(`file-flake-issue: updated https://github.com/${repo}/issues/${existingNumber}`);
} else {
  console.log('file-flake-issue: creating new issue');
  const out = ghWithStdinBody([
    'issue',
    'create',
    '--repo',
    repo,
    '--title',
    title,
    '--body-file',
    '-',
    '--label',
    'bug',
    '--label',
    'agent:code-quality',
  ]);
  console.log(out.trim());
}
