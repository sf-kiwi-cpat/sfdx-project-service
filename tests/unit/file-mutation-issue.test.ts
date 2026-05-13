/*
 * Copyright (c) 2026, Salesforce, Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Lock in the non-happy-path behaviour of scripts/file-mutation-issue.js.
// The CI invocation only ever exercises the happy path (real Stryker JSON
// from a real run). These cases — missing report, malformed JSON, unknown
// shape, no survivors, body rendering — are the ones a future refactor is
// most likely to silently break.
//
// We run the script in DRY_RUN mode so the assertions don't depend on a
// live `gh` binary and don't shell out to the network. The DRY_RUN exit
// path is the same code path that produces the body for the real
// invocation, so coverage of body rendering carries over.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../../scripts/file-mutation-issue.js');

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'mutation-issue-'));
  // The script reads from `<cwd>/reports/mutation/mutation.json`, so set
  // up that exact layout under the temp dir.
  mkdirSync(path.join(workDir, 'reports', 'mutation'), { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function runScript(reportContent: string | null, env: NodeJS.ProcessEnv = {}) {
  if (reportContent !== null) {
    writeFileSync(path.join(workDir, 'reports', 'mutation', 'mutation.json'), reportContent);
  }
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    cwd: workDir,
    env: {
      ...process.env,
      DRY_RUN: 'true',
      // Strip GITHUB_REPOSITORY in case the test runner is itself
      // running in CI — DRY_RUN short-circuits before the repo lookup
      // anyway, but leaving it set could mask a regression that moves
      // logic past the DRY_RUN gate.
      GITHUB_REPOSITORY: '',
      ...env,
    },
  });
}

function makeReport(opts: {
  survivors?: Array<{
    file: string;
    line: number;
    mutator: string;
    replacement?: string;
    sourceLine?: string;
  }>;
  killed?: number;
  timeouts?: number;
  noCoverage?: number;
  source?: Record<string, string>;
}) {
  const files: Record<string, { language: string; source: string; mutants: unknown[] }> = {};
  const survivors = opts.survivors ?? [];
  const killed = opts.killed ?? 0;
  const timeouts = opts.timeouts ?? 0;
  const noCoverage = opts.noCoverage ?? 0;

  for (const s of survivors) {
    if (!files[s.file]) {
      // Default: fabricate a 50-line source so the line index resolves.
      files[s.file] = {
        language: 'typescript',
        source:
          opts.source?.[s.file] ??
          Array.from({ length: 50 }, (_, i) => `// line ${i + 1}`).join('\n'),
        mutants: [],
      };
    }
    files[s.file]!.mutants.push({
      id: `${s.file}:${s.line}:${s.mutator}`,
      mutatorName: s.mutator,
      status: 'Survived',
      replacement: s.replacement ?? '',
      location: {
        start: { line: s.line, column: 1 },
        end: { line: s.line, column: 10 },
      },
    });
  }

  // Add killed/timeout/no-coverage mutants spread across one file.
  if (killed > 0 || timeouts > 0 || noCoverage > 0) {
    const filler = Object.keys(files)[0] ?? 'src/filler.ts';
    if (!files[filler]) {
      files[filler] = {
        language: 'typescript',
        source: '// filler',
        mutants: [],
      };
    }
    for (let i = 0; i < killed; i += 1) {
      files[filler]!.mutants.push({
        id: `killed-${i}`,
        mutatorName: 'BooleanLiteral',
        status: 'Killed',
        location: { start: { line: 1, column: 1 }, end: { line: 1, column: 5 } },
      });
    }
    for (let i = 0; i < timeouts; i += 1) {
      files[filler]!.mutants.push({
        id: `timeout-${i}`,
        mutatorName: 'BooleanLiteral',
        status: 'Timeout',
        location: { start: { line: 1, column: 1 }, end: { line: 1, column: 5 } },
      });
    }
    for (let i = 0; i < noCoverage; i += 1) {
      files[filler]!.mutants.push({
        id: `nocov-${i}`,
        mutatorName: 'BooleanLiteral',
        status: 'NoCoverage',
        location: { start: { line: 1, column: 1 }, end: { line: 1, column: 5 } },
      });
    }
  }

  return JSON.stringify({ schemaVersion: '1', files, thresholds: { high: 80, low: 60, break: 0 } });
}

describe('file-mutation-issue.js', () => {
  it('renders a DRY_RUN body grouping survivors by file with line, mutator, and source snippet', () => {
    const sourceLines = [
      'function compute(n: number) {',
      '  if (n > 0) return n + 1;',
      '  return 0;',
      '}',
    ];
    const report = makeReport({
      survivors: [
        { file: 'src/foo.ts', line: 2, mutator: 'EqualityOperator', replacement: 'n >= 0' },
        { file: 'src/foo.ts', line: 3, mutator: 'BlockStatement', replacement: '{}' },
        { file: 'src/bar.ts', line: 1, mutator: 'StringLiteral', replacement: '""' },
      ],
      killed: 7,
      source: {
        'src/foo.ts': sourceLines.join('\n'),
        'src/bar.ts': '"hello"',
      },
    });

    const result = runScript(report);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('DRY RUN');
    // Title encodes the survivor count (so the issue list shows it
    // at-a-glance).
    expect(result.stdout).toMatch(
      /title: \[mutation\] 3 survived mutants — week of \d{4}-\d{2}-\d{2}/
    );
    // Both files appear, with their per-file survivor counts.
    expect(result.stdout).toContain('### `src/foo.ts` — 2 survivor(s)');
    expect(result.stdout).toContain('### `src/bar.ts` — 1 survivor(s)');
    // Per-mutant rows include line number, mutator name, replacement.
    expect(result.stdout).toMatch(/L2.*EqualityOperator.*n >= 0/);
    expect(result.stdout).toMatch(/L3.*BlockStatement/);
    // Source-line snippet for L2 of foo.ts (trimmed, in a code span).
    expect(result.stdout).toContain('if (n > 0) return n + 1;');
    // Mutation score = killed / (killed + survived) = 7 / (7 + 3) = 70.0%.
    expect(result.stdout).toMatch(/mutation score: \*\*70\.0%\*\*/);
  });

  it('orders files most-survivors-first, ties broken alphabetically', () => {
    const report = makeReport({
      survivors: [
        { file: 'src/zeta.ts', line: 1, mutator: 'X' },
        { file: 'src/zeta.ts', line: 2, mutator: 'X' },
        { file: 'src/alpha.ts', line: 1, mutator: 'X' },
        { file: 'src/alpha.ts', line: 2, mutator: 'X' },
        { file: 'src/beta.ts', line: 1, mutator: 'X' },
      ],
    });

    const result = runScript(report);

    expect(result.status).toBe(0);
    // alpha (2) and zeta (2) tie on count; alpha comes first alphabetically.
    // beta (1) trails both.
    const alphaIdx = result.stdout.indexOf('### `src/alpha.ts`');
    const zetaIdx = result.stdout.indexOf('### `src/zeta.ts`');
    const betaIdx = result.stdout.indexOf('### `src/beta.ts`');
    expect(alphaIdx).toBeGreaterThan(-1);
    expect(zetaIdx).toBeGreaterThan(alphaIdx);
    expect(betaIdx).toBeGreaterThan(zetaIdx);
  });

  it('orders mutants within a file by line number for stable diffs', () => {
    const report = makeReport({
      survivors: [
        { file: 'src/x.ts', line: 30, mutator: 'A' },
        { file: 'src/x.ts', line: 5, mutator: 'B' },
        { file: 'src/x.ts', line: 12, mutator: 'C' },
      ],
    });

    const result = runScript(report);

    expect(result.status).toBe(0);
    const l5 = result.stdout.indexOf('**L5**');
    const l12 = result.stdout.indexOf('**L12**');
    const l30 = result.stdout.indexOf('**L30**');
    expect(l5).toBeGreaterThan(-1);
    expect(l12).toBeGreaterThan(l5);
    expect(l30).toBeGreaterThan(l12);
  });

  it('exits 0 with no body when there are zero survivors (Stryker ran but found nothing)', () => {
    const report = makeReport({ survivors: [], killed: 50 });

    const result = runScript(report);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('DRY RUN');
    expect(result.stderr).toContain('no survivors');
  });

  it('reports the suite-aware mutation score (excludes timeouts and no-coverage from the denominator)', () => {
    // Killed 8, survived 2, timed out 5, no-coverage 10 → suite-aware
    // score is 8 / (8 + 2) = 80.0%, not 8 / 25 = 32.0%. The headline
    // number tells the team about *test quality*, not Stryker tuning.
    const report = makeReport({
      survivors: [
        { file: 'src/x.ts', line: 1, mutator: 'A' },
        { file: 'src/x.ts', line: 2, mutator: 'B' },
      ],
      killed: 8,
      timeouts: 5,
      noCoverage: 10,
    });

    const result = runScript(report);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Mutants killed: \*\*8 \/ 10\*\*/);
    expect(result.stdout).toMatch(/mutation score: \*\*80\.0%\*\*/);
    // Total mutants count is also surfaced separately for the
    // Stryker-tuning audience.
    expect(result.stdout).toMatch(/Total mutants generated.*: \*\*25\*\*/);
  });

  it('truncates long replacement strings and source lines so the issue body stays readable', () => {
    const longSource = 'a'.repeat(200);
    const longReplacement = 'r'.repeat(200);
    const report = makeReport({
      survivors: [
        { file: 'src/x.ts', line: 1, mutator: 'StringLiteral', replacement: longReplacement },
      ],
      source: { 'src/x.ts': longSource },
    });

    const result = runScript(report);

    expect(result.status).toBe(0);
    // Replacement truncated at 80 chars (77 + ellipsis).
    expect(result.stdout).toContain('r'.repeat(77) + '...');
    expect(result.stdout).not.toContain('r'.repeat(200));
    // Source line truncated at 120 chars (117 + ellipsis).
    expect(result.stdout).toContain('a'.repeat(117) + '...');
    expect(result.stdout).not.toContain('a'.repeat(200));
  });

  it('escapes backticks in source-line and replacement snippets so the markdown code spans render', () => {
    const report = makeReport({
      survivors: [
        {
          file: 'src/x.ts',
          line: 2,
          mutator: 'StringLiteral',
          replacement: 'foo`bar',
        },
      ],
      source: {
        'src/x.ts': 'a\nconst s = `hello`;\n',
      },
    });

    const result = runScript(report);

    expect(result.status).toBe(0);
    // Backticks in the replacement are escaped so the surrounding
    // markdown code span doesn't break.
    expect(result.stdout).toContain('foo\\`bar');
    // Backticks in the source line are also escaped.
    expect(result.stdout).toContain('const s = \\`hello\\`;');
  });

  it('exits 1 when the report file is missing', () => {
    const result = runScript(null);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('report not found');
  });

  it('exits 1 when the report is malformed JSON', () => {
    const result = runScript('{this is not valid json');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('failed to parse');
  });

  it('exits 1 when the report shape is unexpected (missing files object)', () => {
    const result = runScript(JSON.stringify({ schemaVersion: '1', notFiles: {} }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Stryker JSON shape unexpected');
  });

  it('produces a stable ISO-week Monday stamp in the title regardless of weekday', () => {
    // The week stamp is computed from `new Date()`, so we can't pin it
    // exactly without time-mocking. Instead, lock in the format
    // (YYYY-MM-DD) and the property that the date is a Monday in UTC.
    const report = makeReport({
      survivors: [{ file: 'src/x.ts', line: 1, mutator: 'A' }],
    });

    const result = runScript(report);

    expect(result.status).toBe(0);
    const titleMatch = result.stdout.match(/week of (\d{4}-\d{2}-\d{2})/);
    expect(titleMatch).not.toBeNull();
    const stamp = titleMatch![1]!;
    const date = new Date(`${stamp}T00:00:00Z`);
    expect(date.getUTCDay()).toBe(1); // Monday.
  });
});
