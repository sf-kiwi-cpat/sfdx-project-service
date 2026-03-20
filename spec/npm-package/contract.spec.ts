/**
 * SPEC TESTS — Human-guarded contract (SDLC 2026)
 *
 * These tests define the contract for npm package consumability.
 * The package must be installable as a tarball and runnable via npx.
 *
 * Acceptance criteria (from issue #80):
 * - npm pack produces a tarball containing only dist/, package.json, and README.md
 * - npx sf-project-service starts the server after npm install ./sf-project-service-<version>.tgz
 *
 * These tests are the source of truth for this feature's external behavior.
 * The AI implementation agent must NOT modify this file.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));

describe('npm package shape', () => {
  describe('package.json fields', () => {
    it('has a files field that includes dist and README.md', () => {
      expect(pkg.files).toBeDefined();
      expect(pkg.files).toContain('dist');
      expect(pkg.files).toContain('README.md');
    });

    it('has a bin field mapping sf-project-service to ./dist/index.js', () => {
      expect(pkg.bin).toBeDefined();
      expect(pkg.bin['sf-project-service']).toBe('./dist/index.js');
    });
  });

  describe('entry point', () => {
    it('src/index.ts starts with a node shebang', () => {
      const source = readFileSync(resolve(root, 'src/index.ts'), 'utf-8');
      expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true);
    });
  });

  describe('tarball contents', () => {
    let packedFiles: string[];

    beforeAll(() => {
      execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'pipe' });
      const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
        cwd: root,
        encoding: 'utf-8',
      });
      const parsed = JSON.parse(output);
      packedFiles = parsed[0].files.map((f: { path: string }) => f.path);
    });

    it('includes package.json', () => {
      expect(packedFiles).toContain('package.json');
    });

    it('includes README.md', () => {
      expect(packedFiles).toContain('README.md');
    });

    it('includes files under dist/', () => {
      const distFiles = packedFiles.filter((f: string) => f.startsWith('dist/'));
      expect(distFiles.length).toBeGreaterThan(0);
    });

    it('does not include source files, tests, or config files', () => {
      const forbidden = packedFiles.filter(
        (f: string) =>
          f.startsWith('src/') ||
          f.startsWith('spec/') ||
          f.startsWith('tests/') ||
          f === 'Dockerfile' ||
          f === 'tsconfig.json' ||
          f.startsWith('.')
      );
      expect(forbidden).toEqual([]);
    });
  });
});
