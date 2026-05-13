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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Lock in the non-happy-path behaviour of scripts/test-timing-report.js.
// The CI invocation only ever exercises the happy path (real vitest JSON
// from a real test run). These cases — empty results, malformed JSON,
// non-`passed`/`failed` statuses, missing files — are the ones a future
// refactor is most likely to silently break.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../../scripts/test-timing-report.js');

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'timing-report-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function runReport(input: string, extraArgs: string[] = []) {
  const inputPath = path.join(workDir, 'test-results.json');
  writeFileSync(inputPath, input);
  return spawnSync(process.execPath, [SCRIPT, `--input=${inputPath}`, '--top=20', ...extraArgs], {
    encoding: 'utf8',
    cwd: workDir,
  });
}

describe('test-timing-report.js', () => {
  it('excludes pending / todo / skipped tests; ranks only passed and failed by duration', () => {
    const fixture = {
      testResults: [
        {
          name: path.join(workDir, 'tests/unit/example.test.ts'),
          assertionResults: [
            { fullName: 'fast pass', duration: 10, status: 'passed' },
            { fullName: 'slow pass', duration: 500, status: 'passed' },
            { fullName: 'pending one', duration: null, status: 'pending' },
            { fullName: 'todo one', duration: null, status: 'todo' },
            { fullName: 'skipped one', duration: null, status: 'skipped' },
            { fullName: 'failed one', duration: 200, status: 'failed' },
          ],
        },
      ],
    };

    const result = runReport(JSON.stringify(fixture));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Top 20 slowest tests');
    // Order: 500ms (slow pass) > 200ms (failed) > 10ms (fast pass).
    const slowIdx = result.stdout.indexOf('slow pass');
    const failedIdx = result.stdout.indexOf('failed one');
    const fastIdx = result.stdout.indexOf('fast pass');
    expect(slowIdx).toBeGreaterThan(-1);
    expect(failedIdx).toBeGreaterThan(slowIdx);
    expect(fastIdx).toBeGreaterThan(failedIdx);
    // The non-executed statuses must not appear at all.
    expect(result.stdout).not.toContain('pending one');
    expect(result.stdout).not.toContain('todo one');
    expect(result.stdout).not.toContain('skipped one');
    // Failed tests are tagged so the eye can pick them out.
    expect(result.stdout).toMatch(/failed one\s+\[FAILED\]/);
    // Footer should report 3 executed tests with timing data (the three
    // non-skipped ones), not 6.
    expect(result.stdout).toContain('showing 3 of 3 executed tests');
  });

  it('drops rows whose duration coerces to a non-finite Number (defends against shape drift)', () => {
    // The script does `Number(test.duration)` then `Number.isFinite(...)`.
    // The realistic shape-drift failure modes are string-NaN, missing
    // duration, and garbage strings — all coerce to NaN and get dropped.
    // The contract this test is locking in is the *non-finite* filter
    // specifically. A future refactor that swaps the guard for one that
    // also filters nullish values would break this test plus the
    // companion `Number(null) === 0` case below, prompting the author to
    // update both the script and the assertions in the same commit.
    const fixture = {
      testResults: [
        {
          name: path.join(workDir, 'tests/unit/example.test.ts'),
          assertionResults: [
            { fullName: 'good row', duration: 42, status: 'passed' },
            { fullName: 'string dur', duration: 'NaN', status: 'passed' },
            { fullName: 'undefined dur', status: 'passed' },
            { fullName: 'garbage str', duration: 'abc', status: 'passed' },
          ],
        },
      ],
    };

    const result = runReport(JSON.stringify(fixture));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('good row');
    expect(result.stdout).not.toContain('string dur');
    expect(result.stdout).not.toContain('undefined dur');
    expect(result.stdout).not.toContain('garbage str');
    expect(result.stdout).toContain('showing 1 of 1 executed tests');
  });

  it('documents Number(null) === 0 falling through Number.isFinite guard', () => {
    // `Number(null)` is `0`, which IS finite — so a `passed` test with
    // `duration: null` slips through the script's `Number.isFinite(...)`
    // guard and renders as a 0ms row at the bottom of the top-N list.
    // This is a minor cosmetic glitch, not a correctness break, and
    // it's the kind of thing worth documenting in its own named case so
    // the test report output reads as "documented bug behaviour, not
    // desired behaviour." The next person who tightens the guard (e.g.
    // `Number.isFinite(d) && d > 0`, or a nullish-coalesce guard) will
    // see this case fail and update both the script and this assertion
    // in the same commit.
    const fixture = {
      testResults: [
        {
          name: path.join(workDir, 'tests/unit/example.test.ts'),
          assertionResults: [
            { fullName: 'real row', duration: 42, status: 'passed' },
            { fullName: 'null dur', duration: null, status: 'passed' },
          ],
        },
      ],
    };

    const result = runReport(JSON.stringify(fixture));

    expect(result.status).toBe(0);
    // Both rows kept — the null-duration row coerces to 0ms and survives
    // the finite-number filter.
    expect(result.stdout).toContain('real row');
    expect(result.stdout).toContain('null dur');
    expect(result.stdout).toContain('showing 2 of 2 executed tests');
    // The null-duration row should render as 0ms.
    expect(result.stdout).toMatch(/0ms\s+null dur/);
  });

  it('prints the empty-results banner when no executed tests have timing data', () => {
    // Every entry is filtered out (skipped / non-finite duration), so the
    // sorted list is empty and the script must take the early-exit branch
    // rather than printing a malformed empty table.
    const fixture = {
      testResults: [
        {
          name: path.join(workDir, 'tests/unit/empty.test.ts'),
          assertionResults: [
            { fullName: 'skipped one', duration: null, status: 'skipped' },
            { fullName: 'pending one', duration: null, status: 'pending' },
          ],
        },
      ],
    };

    const result = runReport(JSON.stringify(fixture));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('(no test timing data found)');
    expect(result.stdout).not.toContain('showing ');
  });

  it('includes the tier label in the heading when --tier is provided', () => {
    const fixture = {
      testResults: [
        {
          name: path.join(workDir, 'tests/unit/example.test.ts'),
          assertionResults: [{ fullName: 'a test', duration: 5, status: 'passed' }],
        },
      ],
    };

    const result = runReport(JSON.stringify(fixture), ['--tier=integration']);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Top 20 slowest tests \(integration\)/);
  });

  it('exits non-zero with a clear message when the input file is malformed JSON', () => {
    const result = runReport('this is not json{{{');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('failed to parse');
  });

  it('exits non-zero when the input file is missing', () => {
    // Don't write any input file — point the script at a path that
    // doesn't exist. This is the "CI wiring upstream broke" scenario:
    // failing loudly is the contract, not silently producing no output.
    const missing = path.join(workDir, 'does-not-exist.json');
    const result = spawnSync(process.execPath, [SCRIPT, `--input=${missing}`], {
      encoding: 'utf8',
      cwd: workDir,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('input file not found');
  });
});
