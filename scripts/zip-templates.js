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
import { execFileSync, execSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const srcDir = join(root, 'templates', 'src');
const distDir = join(root, 'templates', 'dist');

// Fail early with a clear message if the system `zip` CLI is missing —
// otherwise execFileSync below would surface a bare ENOENT.
try {
  execFileSync('zip', ['-v'], { stdio: 'ignore' });
} catch {
  console.error(
    'error: the `zip` CLI is required to build templates but was not found on PATH.\n' +
      '  install via: apt-get install zip / brew install zip / choco install zip'
  );
  process.exit(1);
}

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

  // Validate template.json fields
  const meta = JSON.parse(readFileSync(templateJsonPath, 'utf-8'));
  if (meta.id !== name) {
    console.error(`  ${name}: template.json id "${meta.id}" does not match folder name, skipping`);
    continue;
  }
  if (typeof meta.name !== 'string' || meta.name.length === 0) {
    console.error(`  ${name}: template.json missing or empty "name", skipping`);
    continue;
  }
  if (typeof meta.description !== 'string' || meta.description.length === 0) {
    console.error(`  ${name}: template.json missing or empty "description", skipping`);
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
    console.error(`  ${name}: installing dependencies…`);
    execSync('npm install --ignore-scripts', { cwd: contentDir, stdio: 'pipe' });
  }

  // Zip content/ directory using the `zip` CLI. We intentionally avoid an
  // adm-zip dev dep here — the production code uses extract-zip (async,
  // yauzl-backed) and we don't want adm-zip in package.json at all.
  // `zip -r <out> .` from within contentDir produces relative entries that
  // mirror what adm-zip's addLocalFolder did. -X strips extra file
  // attributes for reproducibility; -q quiets per-file output.
  const zipPath = join(outDir, 'content.zip');
  // Remove any pre-existing output so `zip` writes a fresh archive instead
  // of appending. (rmSync above clears distDir, but be explicit.)
  rmSync(zipPath, { force: true });
  execFileSync('zip', ['-r', '-q', '-X', zipPath, '.'], { cwd: contentDir, stdio: 'pipe' });
  console.error(`  ${name} → ${outDir}/`);
}

console.error(`Built ${templates.length} template(s).`);
