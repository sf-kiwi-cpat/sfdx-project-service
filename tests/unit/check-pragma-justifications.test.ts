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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The script is plain JS and exports its parser/checker for tests.
// @ts-expect-error — JS module without an .d.ts shim; test-only import.
import {
  parseUnifiedDiff,
  findViolations,
  checkPragmas,
} from '../../scripts/check-pragma-justifications.js';

describe('parseUnifiedDiff', () => {
  it('extracts added lines with their line numbers in the post-image', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -10,0 +11,2 @@',
      '+const x = 1;',
      '+const y = 2;',
    ].join('\n');

    expect(parseUnifiedDiff(diff)).toEqual([
      { file: 'src/foo.ts', line: 11, content: 'const x = 1;' },
      { file: 'src/foo.ts', line: 12, content: 'const y = 2;' },
    ]);
  });

  it('skips files outside src/**/*.ts (e.g. tests, scripts)', () => {
    const diff = [
      'diff --git a/tests/unit/foo.test.ts b/tests/unit/foo.test.ts',
      '--- a/tests/unit/foo.test.ts',
      '+++ b/tests/unit/foo.test.ts',
      '@@ -10,0 +11,1 @@',
      '+/* v8 ignore next */',
    ].join('\n');

    // tests/ are not subject to the pragma rule — they're agent-mutable
    // quality tools, not production code.
    expect(parseUnifiedDiff(diff)).toEqual([]);
  });

  it('does not record removed lines (only `+`, not `-`)', () => {
    const diff = [
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -10,1 +10,0 @@',
      '-const removed = 1;',
    ].join('\n');

    expect(parseUnifiedDiff(diff)).toEqual([]);
  });
});

describe('findViolations', () => {
  it('flags a pragma without a same-line justification', () => {
    const lines = [
      {
        file: 'src/foo.ts',
        line: 5,
        content: 'const x = maybe ?? /* v8 ignore next */ defaultValue;',
      },
    ];
    expect(findViolations(lines)).toEqual(lines);
  });

  it('passes a pragma with a same-line justification', () => {
    const lines = [
      {
        file: 'src/foo.ts',
        line: 5,
        content:
          'const x = maybe ?? /* v8 ignore next */ defaultValue; // justification: TS narrows',
      },
    ];
    expect(findViolations(lines)).toEqual([]);
  });

  it('flags a pragma when the justification is on a different line', () => {
    // The justification on the line below is not seen — each line is
    // checked in isolation. This is the documented "REJECTED" case
    // from the issue body.
    const lines = [
      { file: 'src/foo.ts', line: 5, content: '/* v8 ignore next */' },
      {
        file: 'src/foo.ts',
        line: 6,
        content: 'const x = maybe ?? defaultValue; // justification: TS narrows',
      },
    ];
    expect(findViolations(lines)).toEqual([
      { file: 'src/foo.ts', line: 5, content: '/* v8 ignore next */' },
    ]);
  });

  it('matches every documented v8-ignore variant (next, next N, start, stop)', () => {
    const variants = [
      '/* v8 ignore next */',
      '/* v8 ignore next 3 */',
      '/* v8 ignore start */',
      '/* v8 ignore stop */',
    ];
    for (const variant of variants) {
      expect(findViolations([{ file: 'src/foo.ts', line: 1, content: variant }])).toHaveLength(1);
    }
  });

  it('does not flag lines that merely mention the string in a string literal', () => {
    // Catch-all sanity: a line containing "v8 ignore" without the
    // surrounding /* */ comment delimiters is not a pragma.
    const lines = [
      { file: 'src/foo.ts', line: 1, content: 'const docs = "v8 ignore next is a pragma";' },
    ];
    expect(findViolations(lines)).toEqual([]);
  });
});

describe('checkPragmas (end-to-end, with stub diff)', () => {
  let originalWrite: typeof process.stderr.write;
  let stderrChunks: string[];

  beforeEach(() => {
    stderrChunks = [];
    originalWrite = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.stderr.write = ((chunk: any) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
    vi.restoreAllMocks();
  });

  it('returns 0 when a new pragma has a same-line justification', () => {
    const diff = [
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,0 +1,1 @@',
      '+const x = a ?? /* v8 ignore next */ b; // justification: TS narrows',
    ].join('\n');

    const code = checkPragmas({ base: 'origin/main', runDiff: () => diff });
    expect(code).toBe(0);
    expect(stderrChunks.join('')).toBe('');
  });

  it('returns 1 with a file:line message when a new pragma lacks justification', () => {
    const diff = [
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,0 +5,1 @@',
      '+const x = a ?? /* v8 ignore next */ b;',
    ].join('\n');

    const code = checkPragmas({ base: 'origin/main', runDiff: () => diff });
    expect(code).toBe(1);
    const out = stderrChunks.join('');
    expect(out).toContain('src/foo.ts:5:');
    expect(out).toContain('/* v8 ignore next */');
  });

  it('returns 0 when the diff does not touch coverage pragmas', () => {
    const diff = [
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,0 +1,1 @@',
      '+const x = a + b;',
    ].join('\n');

    expect(checkPragmas({ base: 'origin/main', runDiff: () => diff })).toBe(0);
  });

  it('returns 0 when the diff only removes a pragma (cleanup is good)', () => {
    const diff = [
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,1 +1,0 @@',
      '-const x = a ?? /* v8 ignore next */ b;',
    ].join('\n');

    expect(checkPragmas({ base: 'origin/main', runDiff: () => diff })).toBe(0);
  });
});
