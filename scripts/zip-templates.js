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
import { requireZipCli } from './lib/require-zip-cli.js';

const root = resolve(import.meta.dirname, '..');
const srcDir = join(root, 'templates', 'src');
const distDir = join(root, 'templates', 'dist');

// Fail early with a clear message if the system `zip` CLI is missing —
// otherwise the execFileSync('zip', ...) below would surface a bare
// ENOENT. Shared with the test-fixture builder in
// tests/unit/projects.test.ts so the actionable message reaches both
// surfaces.
try {
  requireZipCli();
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
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

  // Install deps at the project root if a root package.json exists.
  // Legacy templates keep React deps at project root; bundle-layout templates
  // have moved deps under force-app/.../uiBundles/<name>/ so the root
  // package.json may not exist.
  if (existsSync(join(contentDir, 'package.json'))) {
    console.error(`  ${name}: installing dependencies (root)…`);
    execSync('npm install --ignore-scripts', { cwd: contentDir, stdio: 'pipe' });
  }

  // For bundle-layout templates, also install deps inside the bundle dir so
  // the preview-service's Vite server (rooted there) can resolve
  // @vitejs/plugin-react, @salesforce/vite-plugin-ui-bundle, etc. at runtime.
  const bundleRoot = join(contentDir, 'force-app', 'main', 'default', 'uiBundles');
  if (existsSync(bundleRoot)) {
    for (const bundleName of readdirSync(bundleRoot)) {
      const bundleDir = join(bundleRoot, bundleName);
      if (!statSync(bundleDir).isDirectory()) continue;
      if (!existsSync(join(bundleDir, 'package.json'))) continue;
      console.error(`  ${name}: installing dependencies (uiBundles/${bundleName})…`);
      execSync('npm install --ignore-scripts', { cwd: bundleDir, stdio: 'pipe' });
    }
  }

  // Zip content/ directory using the system `zip` CLI — keeps adm-zip out
  // of package.json (production uses extract-zip; we don't want both).
  // `-r` recurses, `-q` quiets per-file output, `-X` strips extra file
  // attributes for reproducibility.
  const zipPath = join(outDir, 'content.zip');
  // Remove any pre-existing output so `zip` writes a fresh archive instead
  // of appending. (rmSync above clears distDir, but be explicit.)
  rmSync(zipPath, { force: true });
  execFileSync('zip', ['-r', '-q', '-X', zipPath, '.'], { cwd: contentDir, stdio: 'pipe' });
  console.error(`  ${name} → ${outDir}/`);
}

console.error(`Built ${templates.length} template(s).`);
