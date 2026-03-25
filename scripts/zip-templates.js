#!/usr/bin/env node

/**
 * Zips each subdirectory of templates/src/ into templates/dist/.
 * Templates with a package.json get `npm install` run first so the
 * zip includes node_modules (self-contained, like npm pack).
 */

import { readdirSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import AdmZip from 'adm-zip';

const root = resolve(import.meta.dirname, '..');
const srcDir = join(root, 'templates', 'src');
const distDir = join(root, 'templates', 'dist');

mkdirSync(distDir, { recursive: true });

const templates = readdirSync(srcDir).filter((name) =>
  statSync(join(srcDir, name)).isDirectory()
);

for (const name of templates) {
  const templateDir = join(srcDir, name);

  // Install deps so the zip is self-contained
  if (existsSync(join(templateDir, 'package.json'))) {
    console.log(`  ${name}: installing dependencies…`);
    execSync('npm install --ignore-scripts', { cwd: templateDir, stdio: 'pipe' });
  }

  const zip = new AdmZip();
  zip.addLocalFolder(templateDir);
  const outPath = join(distDir, `${name}.zip`);
  zip.writeZip(outPath);
  console.log(`  ${name} → ${outPath}`);
}

console.log(`Zipped ${templates.length} template(s).`);
