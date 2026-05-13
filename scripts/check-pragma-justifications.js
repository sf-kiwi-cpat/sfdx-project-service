#!/usr/bin/env node

/**
 * CI gate: every NEW `/* v8 ignore *\/` pragma added in a PR diff must be
 * paired with a same-line `// justification: <reason>` comment.
 *
 * Why a gate, not a lint rule:
 *   The justification rule lives in tests/CLAUDE.md (see issue #238). A
 *   doc rule only catches the bad case if a human reviewer notices the
 *   new pragma in the diff. This script turns review-time discipline
 *   into a deterministic check — the same forcing-function pattern
 *   used by the coverage threshold gate.
 *
 * What it does NOT do:
 *   - Touch existing pragmas on `main`. Only added lines in the PR diff
 *     are inspected. Branches that pre-date this gate are not failed
 *     retroactively.
 *   - Verify the *content* of the justification. A trivial
 *     "// justification: because" passes. The point is to force a
 *     contributor to type *something*; review handles content quality.
 *   - Parse TypeScript. Pragmas split across lines, unusual whitespace,
 *     or other deliberate evasions will slip through. Grep is the right
 *     tool for the 99% case here — see the issue #278 tradeoffs section.
 *
 * Inputs:
 *   --base=<ref>      Base ref to diff against. Defaults to env
 *                     PRAGMA_CHECK_BASE_REF, then GITHUB_BASE_REF
 *                     prefixed with `origin/`, then `origin/main`.
 *   --diff-file=<path>  Read a unified diff from this file instead of
 *                     running git. Used by tests; not used in CI.
 *
 * Output:
 *   Exits 0 on success. On failure, prints one line per violation in
 *   the form `<file>:<line>: <added line>` and exits 1.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { argv, exit, stderr, stdout } from 'node:process';

// Match any /* v8 ignore <variant> */ form. v8's documented variants are
// `next`, `next N`, `start`, `stop` — be liberal in what we match here so
// a new variant doesn't slip past the gate.
const PRAGMA_RE = /\/\*\s*v8\s+ignore\b[^*]*\*\//;
const JUSTIFICATION_RE = /\/\/\s*justification:/;

/**
 * Parse the unified diff text into a list of added lines.
 *
 * Returns an array of { file, line, content } where `line` is the
 * line number in the *new* (post-PR) file. Only `+` lines from hunks
 * scoped to `src/**\/*.ts` are returned.
 *
 * Why we re-implement instead of pulling a parser dep: the diff format
 * we need is narrow (added lines only, with line numbers, in a fixed
 * file scope) and adding a runtime dep to a CI-only script is more
 * weight than the 30 lines below.
 */
export function parseUnifiedDiff(diffText) {
  const lines = diffText.split('\n');
  const added = [];
  let currentFile = null;
  let newLineNum = 0;
  let inSrcTs = false;

  for (const line of lines) {
    if (line.startsWith('+++ ')) {
      // `+++ b/src/foo.ts` — the post-image path. Strip the `b/` prefix.
      const path = line.slice(4).replace(/^b\//, '');
      currentFile = path;
      inSrcTs = path.startsWith('src/') && path.endsWith('.ts');
      continue;
    }
    if (line.startsWith('--- ')) {
      // The pre-image path. Ignore — we key off the post-image.
      continue;
    }
    if (line.startsWith('@@')) {
      // `@@ -<old>,<oldlen> +<new>,<newlen> @@`. We only need <new>.
      const match = line.match(/\+(\d+)(?:,\d+)?/);
      if (match) {
        newLineNum = Number(match[1]);
      }
      continue;
    }
    if (!inSrcTs || !currentFile) {
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added.push({ file: currentFile, line: newLineNum, content: line.slice(1) });
      newLineNum += 1;
    } else if (line.startsWith(' ')) {
      // Context line (only present with --unified > 0). Advances the
      // new-file counter.
      newLineNum += 1;
    }
    // `-` lines don't advance the new-file counter.
  }

  return added;
}

/**
 * Inspect added lines for unjustified pragmas.
 *
 * A line is a violation iff it matches PRAGMA_RE and does NOT also
 * match JUSTIFICATION_RE (both checks against the same line text).
 *
 * Returns the violations as an array of { file, line, content }.
 */
export function findViolations(addedLines) {
  return addedLines.filter(
    ({ content }) => PRAGMA_RE.test(content) && !JUSTIFICATION_RE.test(content)
  );
}

/**
 * Top-level entry point. Resolves the base ref, runs git diff, parses
 * the result, prints violations, and returns the exit code.
 *
 * Exported so tests can drive it with a fake `runDiff`.
 */
export function checkPragmas({ base, runDiff }) {
  const diffText = runDiff(base);
  const added = parseUnifiedDiff(diffText);
  const violations = findViolations(added);

  if (violations.length === 0) {
    return 0;
  }

  stderr.write(
    `Found ${violations.length} new v8-ignore pragma${violations.length === 1 ? '' : 's'} without same-line "// justification:" comment.\n` +
      `See tests/CLAUDE.md for the rule, and issue #238 for the rationale.\n\n`
  );
  for (const v of violations) {
    stderr.write(`${v.file}:${v.line}: ${v.content.trim()}\n`);
  }
  return 1;
}

function parseArgs(args) {
  const opts = {};
  for (const arg of args) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) {
      opts[match[1]] = match[2];
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    }
  }
  return opts;
}

function resolveBaseRef(cliBase) {
  if (cliBase) return cliBase;
  if (process.env.PRAGMA_CHECK_BASE_REF) return process.env.PRAGMA_CHECK_BASE_REF;
  if (process.env.GITHUB_BASE_REF) return `origin/${process.env.GITHUB_BASE_REF}`;
  return 'origin/main';
}

function gitDiff(base) {
  // --unified=0 keeps hunks tight; we only inspect added lines so we
  // don't need context. -- 'src/**/*.ts' scopes to TypeScript sources.
  // Note: the `**` glob is interpreted by git's pathspec, not the
  // shell — execFileSync with an array bypasses shell expansion.
  return execFileSync(
    'git',
    ['diff', `${base}...HEAD`, '--unified=0', '--', 'src/**/*.ts'],
    { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
  );
}

// Only run when executed as a script — not when imported by tests.
const isMain = import.meta.url === `file://${argv[1]}`;
if (isMain) {
  const opts = parseArgs(argv.slice(2));
  if (opts.help) {
    stdout.write(
      'Usage: check-pragma-justifications.js [--base=<ref>] [--diff-file=<path>]\n' +
        '\n' +
        'Fails (exit 1) if any line added by the PR diff contains a\n' +
        '/* v8 ignore */ pragma without a same-line // justification:\n' +
        'comment.\n'
    );
    exit(0);
  }
  const base = resolveBaseRef(opts.base);
  const runDiff = opts['diff-file']
    ? () => readFileSync(opts['diff-file'], 'utf-8')
    : gitDiff;
  exit(checkPragmas({ base, runDiff }));
}
