#!/usr/bin/env node

/**
 * Copies non-TS visualizer assets (CSS) from src/visualizer/ to dist/visualizer/
 * so they ship alongside the compiled JS. tsc emits only .ts outputs, so
 * runtime fs.readFile() against the bundled CSS would otherwise miss in dist/.
 */

import { mkdirSync, readdirSync, copyFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const srcDir = join(root, 'src', 'visualizer');
const distDir = join(root, 'dist', 'visualizer');

mkdirSync(distDir, { recursive: true });

const entries = readdirSync(srcDir).filter((name) => {
  if (!statSync(join(srcDir, name)).isFile()) return false;
  return name.endsWith('.css');
});

for (const name of entries) {
  copyFileSync(join(srcDir, name), join(distDir, name));
  console.error(`  ${name} → dist/visualizer/`);
}

console.error(`Copied ${entries.length} visualizer asset(s).`);
