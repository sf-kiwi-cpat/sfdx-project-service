#!/usr/bin/env node

/**
 * Zips each subdirectory of templates/src/ into templates/dist/.
 * Uses adm-zip (already a project dependency).
 */

import { readdirSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import AdmZip from 'adm-zip';

const root = resolve(import.meta.dirname, '..');
const srcDir = join(root, 'templates', 'src');
const distDir = join(root, 'templates', 'dist');

mkdirSync(distDir, { recursive: true });

const templates = readdirSync(srcDir).filter((name) =>
  statSync(join(srcDir, name)).isDirectory()
);

for (const name of templates) {
  const zip = new AdmZip();
  zip.addLocalFolder(join(srcDir, name));
  const outPath = join(distDir, `${name}.zip`);
  zip.writeZip(outPath);
  console.log(`  ${name} → ${outPath}`);
}

console.log(`Zipped ${templates.length} template(s).`);
