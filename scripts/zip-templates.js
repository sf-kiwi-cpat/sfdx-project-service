#!/usr/bin/env node

/**
 * Builds each template from templates/src/<id>/ into templates/dist/<id>/.
 *
 * Each source template has:
 *   template.json  — metadata (id, name, description), NOT zipped
 *   content/       — project files, zipped into content.zip
 *
 * Output per template:
 *   dist/<id>/template.json
 *   dist/<id>/content.zip
 */

import {
  readdirSync,
  mkdirSync,
  rmSync,
  statSync,
  existsSync,
  copyFileSync,
  readFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import AdmZip from 'adm-zip';

const root = resolve(import.meta.dirname, '..');
const srcDir = join(root, 'templates', 'src');
const distDir = join(root, 'templates', 'dist');

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const templates = readdirSync(srcDir).filter((name) => statSync(join(srcDir, name)).isDirectory());

for (const name of templates) {
  const templateDir = join(srcDir, name);
  const contentDir = join(templateDir, 'content');
  const templateJsonPath = join(templateDir, 'template.json');
  const outDir = join(distDir, name);

  mkdirSync(outDir, { recursive: true });

  // Validate template.json exists
  if (!existsSync(templateJsonPath)) {
    console.error(`  ${name}: missing template.json, skipping`);
    continue;
  }

  // Validate id in template.json matches folder name
  const meta = JSON.parse(readFileSync(templateJsonPath, 'utf-8'));
  if (meta.id !== name) {
    console.error(`  ${name}: template.json id "${meta.id}" does not match folder name, skipping`);
    continue;
  }

  // Copy template.json (not zipped)
  copyFileSync(templateJsonPath, join(outDir, 'template.json'));

  // Validate content/ directory exists
  if (!existsSync(contentDir) || !statSync(contentDir).isDirectory()) {
    console.error(`  ${name}: missing content/ directory, skipping`);
    continue;
  }

  // Install deps in content/ if needed
  if (existsSync(join(contentDir, 'package.json'))) {
    console.log(`  ${name}: installing dependencies…`);
    execSync('npm install --ignore-scripts', { cwd: contentDir, stdio: 'pipe' });
  }

  // Zip content/ directory
  const zip = new AdmZip();
  zip.addLocalFolder(contentDir);
  const zipPath = join(outDir, 'content.zip');
  zip.writeZip(zipPath);
  console.log(`  ${name} → ${outDir}/`);
}

console.log(`Built ${templates.length} template(s).`);
