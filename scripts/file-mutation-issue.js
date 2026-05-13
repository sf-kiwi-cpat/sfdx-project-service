#!/usr/bin/env node

/**
 * Read reports/mutation/mutation.json and file (or update) one tracking
 * issue per ISO week listing the surviving mutants detected.
 *
 * Source of truth for the issue this implements: GitHub #241.
 *
 * Why one issue per ISO week (not per run): the workflow runs daily but
 * is also `workflow_dispatch`able for ad-hoc verification. Multiple runs
 * within the same ISO week refresh the same issue, not spawn duplicates
 * that humans then have to dedupe by hand. Same dedup pattern as the
 * weekly flake-detection job (#245). Daily cadence × weekly issue
 * window means today's run editing yesterday's issue is the expected
 * steady-state behaviour — exactly what we want the team to read.
 *
 * Why we filter to survived mutants only: Stryker also reports timeouts,
 * runtime errors, no-coverage, and ignored mutants. Those are noise for
 * the test-quality signal we care about — a mutant that *survived* is a
 * test the suite can't tell apart from broken code, and that's the
 * actionable bucket. The other statuses are interesting for
 * Stryker-tuning work but not for the daily issue.
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
 * Output streams (matches `file-flake-issue.js`):
 *   stdout — payload only: the rendered issue body in DRY_RUN, and the
 *            URL `gh issue create` prints on success
 *   stderr — everything else: progress, status, and diagnostics
 *
 * Exit code:
 *   0 — issue filed/updated successfully, or DRY_RUN=true succeeded,
 *       or no survivors were found (nothing to file)
 *   1 — anything else (invalid report, gh failure, etc.)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPORT_PATH = resolve(process.cwd(), 'reports/mutation/mutation.json');
const DRY_RUN = String(process.env.DRY_RUN ?? '').toLowerCase() === 'true';

if (!existsSync(REPORT_PATH)) {
  console.error(`file-mutation-issue: report not found at ${REPORT_PATH}`);
  console.error('  did `npx stryker run` complete?');
  process.exit(1);
}

let report;
try {
  report = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
} catch (err) {
  console.error(`file-mutation-issue: failed to parse ${REPORT_PATH}: ${err.message}`);
  process.exit(1);
}

// Stryker's mutation-testing-elements JSON shape:
//   {
//     "files": {
//       "<file path>": {
//         "language": "typescript",
//         "source": "...",
//         "mutants": [
//           { "id", "mutatorName", "status", "location": {start:{line,column}, end:{...}}, "replacement", ... }
//         ]
//       }, ...
//     },
//     "schemaVersion": "...",
//     "thresholds": { ... }
//   }
//
// We extract every mutant whose status === "Survived" and group by file.
const files = report?.files;
if (!files || typeof files !== 'object') {
  console.error('file-mutation-issue: report missing `files` object — Stryker JSON shape unexpected');
  process.exit(1);
}

/** @type {Array<{ file: string, mutants: Array<{line:number, mutator:string, replacement:string|undefined, sourceLine:string}> }>} */
const survivorsByFile = [];
let totalSurvived = 0;
let totalMutants = 0;
let totalKilled = 0;

for (const [filePath, fileEntry] of Object.entries(files)) {
  const mutants = Array.isArray(fileEntry?.mutants) ? fileEntry.mutants : [];
  totalMutants += mutants.length;
  // Pre-split source once per file so we can pull the surrounding line
  // for each survivor without re-reading the (potentially large) source
  // string. Stryker reports line numbers as 1-based.
  const sourceLines = typeof fileEntry?.source === 'string' ? fileEntry.source.split('\n') : [];
  /** @type {Array<{line:number, mutator:string, replacement:string|undefined, sourceLine:string}>} */
  const fileSurvivors = [];
  for (const m of mutants) {
    if (m.status === 'Killed') totalKilled += 1;
    if (m.status !== 'Survived') continue;
    const line = m.location?.start?.line ?? 0;
    const sourceLine = sourceLines[line - 1] ?? '';
    fileSurvivors.push({
      line,
      mutator: m.mutatorName ?? '<unknown>',
      replacement: typeof m.replacement === 'string' ? m.replacement : undefined,
      sourceLine: sourceLine.trim(),
    });
  }
  if (fileSurvivors.length > 0) {
    // Sort survivors within a file by line number for stable output.
    fileSurvivors.sort((a, b) => a.line - b.line);
    survivorsByFile.push({ file: filePath, mutants: fileSurvivors });
    totalSurvived += fileSurvivors.length;
  }
}

if (totalSurvived === 0) {
  console.error('file-mutation-issue: no survivors — nothing to file');
  process.exit(0);
}

// Sort files: most survivors first (= where to look first), then alphabetical.
survivorsByFile.sort((a, b) => {
  if (b.mutants.length !== a.mutants.length) return b.mutants.length - a.mutants.length;
  return a.file.localeCompare(b.file);
});

// Mutation score = killed / (killed + survived) when scoped to mutants
// the suite actually had a chance to detect. Stryker's `mutationScore`
// in the JSON includes timeouts and no-coverage in the denominator,
// which can swing the headline number around for reasons unrelated to
// test quality. We compute the suite-aware version here so the issue
// body shows a number that reflects "of the mutants tests saw, how many
// did they catch."
const detectableMutants = totalKilled + totalSurvived;
const mutationScore =
  detectableMutants > 0 ? ((totalKilled / detectableMutants) * 100).toFixed(1) : 'n/a';

/**
 * ISO-week Monday in UTC, formatted YYYY-MM-DD.
 *
 * Same logic as scripts/file-flake-issue.js — keep in sync. ISO-8601
 * week boundary semantics (Sunday belongs to the prior Monday's week)
 * are documented at length there. Daily cadence here means a re-run
 * during the same ISO week edits the same issue; a re-run that
 * straddles the Sunday→Monday UTC boundary will spawn a new issue —
 * intentional, matches the dedup-by-week-stamp contract.
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
const title = `[mutation] ${totalSurvived} survived mutants — week of ${weekStamp}`;

function escapeBackticks(s) {
  // Source-line snippets and replacement strings often contain
  // `code spans`; escape stray backticks so the markdown bullet renders
  // without breaking the code-span balance. Matches the
  // file-flake-issue.js convention.
  return String(s).replace(/`/g, '\\`');
}

function renderBody() {
  const lines = [];
  lines.push(
    'Generated by `npx stryker run` + `scripts/file-mutation-issue.js` — see [GitHub #241](https://github.com/forcedotcom/sfdx-project-service/issues/241).',
  );
  lines.push('');
  lines.push(`Detection window: ISO week starting **${weekStamp} (Monday, UTC)**.`);
  lines.push(`Last run: ${new Date().toISOString()}.`);
  lines.push('');
  lines.push(
    `Mutants killed: **${totalKilled} / ${detectableMutants}** detectable (mutation score: **${mutationScore}%**, suite-aware — excludes timeouts and no-coverage).`,
  );
  lines.push(`Mutants surviving: **${totalSurvived}** across **${survivorsByFile.length}** file(s).`);
  if (totalMutants !== detectableMutants) {
    lines.push(
      `Total mutants generated (incl. timeouts, no-coverage, runtime errors): **${totalMutants}**.`,
    );
  }
  lines.push('');
  lines.push(
    'A "survived" mutant is a deliberate code change Stryker introduced (e.g. flipped `>` to `>=`, removed an `await`, replaced a return value with `null`) that the test suite did **not** detect. Each survivor below points at a piece of code where no current test would fail if the code were silently wrong.',
  );
  lines.push('');
  lines.push(
    'See [Stryker output formats](https://stryker-mutator.io/docs/General/configuration/#reporters) for the full HTML report attached as a workflow artifact.',
  );
  lines.push('');

  lines.push(`## Survivors by file`);
  lines.push('');
  for (const group of survivorsByFile) {
    lines.push(`### \`${group.file}\` — ${group.mutants.length} survivor(s)`);
    lines.push('');
    for (const m of group.mutants) {
      const replacementBlurb =
        m.replacement !== undefined && m.replacement.length > 0
          ? ` → \`${escapeBackticks(m.replacement.length > 80 ? m.replacement.slice(0, 77) + '...' : m.replacement)}\``
          : '';
      lines.push(`- **L${m.line}** \`${m.mutator}\`${replacementBlurb}`);
      if (m.sourceLine) {
        const trimmed = m.sourceLine.length > 120 ? m.sourceLine.slice(0, 117) + '...' : m.sourceLine;
        lines.push(`  - \`${escapeBackticks(trimmed)}\``);
      }
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('## What to do');
  lines.push('');
  lines.push('Pick one per survivor:');
  lines.push('');
  lines.push(
    '1. **Add or strengthen a test.** A survivor usually means a missing assertion (boundary, branch, error path) or an assertion too weak to fail under the mutation. The fastest fix is to write the test that would have killed the mutant.',
  );
  lines.push(
    '2. **Mark it as an equivalent mutant.** Some mutations produce semantically identical behaviour (e.g. `>=` vs `>` on a guard that\'s never actually called with the boundary value). These are not test-quality bugs. Document the reasoning in `stryker.config.json` via [`mutator.excludedMutations`](https://stryker-mutator.io/docs/stryker-js/configuration/#excludedmutations) or per-file `// Stryker disable` comments.',
  );
  lines.push(
    '3. **Delete the code.** A survivor in a function nobody calls is dead code. The mutation surfaces it.',
  );
  lines.push('');
  lines.push(
    'The first run\'s noise is expected (per #241). Treat the issue as a triage backlog — close it when the survivor count drops below a level worth filing about, not when every survivor is killed.',
  );
  lines.push('');
  lines.push(
    'The full HTML report is attached as a workflow artifact (30-day retention) — open the most recent `mutation` run in Actions to download `stryker-report` and inspect mutants in context.',
  );
  lines.push('');
  lines.push(
    '_This issue is auto-updated by the daily `mutation` workflow. A new issue is opened each ISO week; manual edits inside this body will be overwritten on the next run in the same week._',
  );

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
  console.error(
    'file-mutation-issue: could not determine repo (GITHUB_REPOSITORY unset, git remote missing)',
  );
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
// (not `gh issue list --label`) because the search index lets us scope
// to title-only matches reliably. The dedup key is the literal week
// stamp in the title — see CLAUDE.md "gh issue list" gotcha for why we
// avoid `--label` and similar filters. Note we search by week stamp
// only (not by survivor count) so a re-run with a different count still
// hits the existing issue.
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
    `in:title "[mutation]" in:title "week of ${weekStamp}"`,
    '--json',
    'number,title',
    '--limit',
    '5',
  ]);
  const matches = JSON.parse(found).filter(
    (i) => typeof i.title === 'string' && i.title.includes(`week of ${weekStamp}`) && i.title.startsWith('[mutation]'),
  );
  if (matches.length > 0) existingNumber = matches[0].number;
} catch (err) {
  console.error(`file-mutation-issue: gh search failed: ${err.message}`);
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
  console.error(`file-mutation-issue: updating existing issue #${existingNumber}`);
  // Title may have a different survivor count from yesterday's run —
  // refresh both title and body so the at-a-glance count in the issue
  // list stays accurate.
  ghWithStdinBody([
    'issue',
    'edit',
    String(existingNumber),
    '--repo',
    repo,
    '--title',
    title,
    '--body-file',
    '-',
  ]);
  // Issue URL is the payload — emit on stdout so callers can capture it.
  console.log(`https://github.com/${repo}/issues/${existingNumber}`);
} else {
  console.error('file-mutation-issue: creating new issue');
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
    'enhancement',
    '--label',
    'agent:code-quality',
  ]);
  // `gh issue create` prints the new issue URL — pass it through on stdout.
  console.log(out.trim());
}
