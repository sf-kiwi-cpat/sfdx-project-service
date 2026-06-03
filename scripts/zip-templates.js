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
import { join, resolve, relative, sep } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { requireZipCli } from './lib/require-zip-cli.js';

const root = resolve(import.meta.dirname, '..');
const srcDir = join(root, 'templates', 'src');
const distDir = join(root, 'templates', 'dist');

/**
 * Recursively find every `node_modules` directory under `dir`. Does not
 * descend into a found `node_modules` (nested deps belong to their parent
 * tree), keeping the walk cheap — for a directory containing a 6k-file stale
 * tree we only stat its top-level entries, never the tree itself. Returns
 * absolute paths.
 */
function findNodeModulesDirs(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const abs = join(dir, entry.name);
    if (entry.name === 'node_modules') {
      found.push(abs);
      continue; // don't recurse into node_modules
    }
    found.push(...findNodeModulesDirs(abs));
  }
  return found;
}

/**
 * List the entry names stored in a zip archive, using the same `zip` binary
 * the build already requires (`zip -sf`). Entry names are returned verbatim as
 * stored (forward-slash separated, possibly with a trailing `/` for dirs).
 */
function listZipEntries(zipPath) {
  const out = execFileSync('zip', ['-sf', zipPath], { encoding: 'utf-8' });
  // `zip -sf` frames the listing between a header line ("Archive contains:")
  // and a footer ("Total N entries ..."). Entries are indented with a space.
  return out
    .split('\n')
    .filter((line) => line.startsWith(' '))
    .map((line) => line.trim())
    .filter(Boolean);
}

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

  // Directories where we run a dependency install. A created project never
  // builds (no `npm install` at runtime) and the build + preview servers
  // resolve their Vite toolchain from their OWN node_modules, not the
  // project's — so the project only needs PRODUCTION dependencies. We install
  // with `npm ci --omit=dev` to keep ~190 MB of dev toolchain (typescript,
  // esbuild, @babel, rollup, vite) out of content.zip. This is the dominant
  // cost in extraction: data-curator's bundle node_modules drops from ~7,972
  // files to ~240. See spec/template-packaging/contract.md (C2).
  //
  // `installedNodeModules` records every node_modules dir we deliberately
  // created — a Set of absolute paths. Both this Set and the walk below build
  // paths with `join(dir, 'node_modules')` and never realpath/normalize them,
  // so identity comparison is exact; keep it that way. Any node_modules NOT in
  // this Set is unmanaged (e.g. stale local cruft from a dev `npm install`
  // next to a package.json-less directory) and must be kept out of the archive
  // (C1) — `zip -r` would otherwise sweep it in, since it ignores .gitignore.
  const installedNodeModules = new Set();

  const installProdDeps = (dir, label) => {
    // `npm ci` installs exactly the lockfile (deterministic contents, not just
    // a clean tree) and removes any existing node_modules first, so a dev's
    // prior full install can't leak in. `--omit=dev` drops devDependencies.
    console.error(`  ${name}: installing production dependencies (${label})…`);
    execSync('npm ci --omit=dev --ignore-scripts', { cwd: dir, stdio: 'pipe' });
    installedNodeModules.add(join(dir, 'node_modules'));
  };

  // Install deps at the project root if a root package.json exists.
  // Legacy templates (e.g. local-react-test) keep React deps at project root
  // and root Vite there; bundle-layout templates (e.g. data-curator) have
  // moved deps under force-app/.../uiBundles/<name>/ so the root package.json
  // may not exist — in which case any root node_modules is unmanaged.
  if (existsSync(join(contentDir, 'package.json'))) {
    installProdDeps(contentDir, 'root');
  }

  // For bundle-layout templates, install deps inside each bundle dir. The
  // created project ships these so the bundle's runtime deps (react,
  // react-dom, @salesforce/sdk-data) resolve during build/preview.
  const bundleRoot = join(contentDir, 'force-app', 'main', 'default', 'uiBundles');
  if (existsSync(bundleRoot)) {
    for (const bundleName of readdirSync(bundleRoot)) {
      const bundleDir = join(bundleRoot, bundleName);
      if (!statSync(bundleDir).isDirectory()) continue;
      if (!existsSync(join(bundleDir, 'package.json'))) continue;
      installProdDeps(bundleDir, `uiBundles/${bundleName}`);
    }
  }

  // Keep every node_modules we did NOT install (unmanaged trees) out of the
  // archive — e.g. data-curator's stale, untracked root node_modules, which
  // has no package.json so the install above never created it. Build a `zip`
  // exclude pattern per unmanaged tree, relative to contentDir (where zip
  // runs) and POSIX-separated to match how zip stores entry names. We do NOT
  // touch the source tree (no rename/move) so a crashed build can never lose
  // a developer's files; correctness is guaranteed by the post-zip
  // verification below rather than by trusting the exclude alone.
  const unmanaged = findNodeModulesDirs(contentDir).filter(
    (abs) => !installedNodeModules.has(abs)
  );
  const excludeArgs = unmanaged.flatMap((abs) => {
    const rel = relative(contentDir, abs).split(sep).join('/');
    return ['-x', `${rel}/*`, '-x', `${rel}/`];
  });

  // Zip content/ directory using the system `zip` CLI — keeps adm-zip out
  // of package.json (production uses extract-zip; we don't want both).
  const zipPath = join(outDir, 'content.zip');
  // Remove any pre-existing output so `zip` writes a fresh archive instead
  // of appending. (rmSync above clears distDir, but be explicit.)
  rmSync(zipPath, { force: true });
  // Flags: `-r` recurses, `-q` quiets per-file output. `-X` is the
  // load-bearing one for the runtime side: it tells `zip` to omit extra
  // file attribute fields (UID/GID, extended timestamps, etc.) but to
  // *keep* the Unix mode bits in each entry's external file attributes
  // (files 0o644, dirs 0o755). On the consume side
  // (src/domain/projects.ts), extract-zip honors those embedded modes —
  // its `defaultFileMode` / `defaultDirMode` options only fire when an
  // entry's mode is 0, which never happens for archives produced this
  // way (per the lwetmore-sf review on #227). As a side benefit, omitting
  // the extra fields also makes archives more byte-reproducible across
  // builds.
  // `-x` patterns must follow the input spec (`.`).
  execFileSync('zip', ['-r', '-q', '-X', zipPath, '.', ...excludeArgs], {
    cwd: contentDir,
    stdio: 'pipe',
  });

  // Verify the exclude actually took: `zip`'s `-x` glob semantics vary across
  // Info-ZIP builds, and an unmatched pattern fails OPEN (silently ships the
  // tree). Re-read the archive and fail the build loudly if any unmanaged
  // node_modules leaked in. This turns a silent perf/size regression into a
  // hard build error on any host. (C1, see spec/template-packaging/contract.md)
  if (unmanaged.length > 0) {
    const entries = listZipEntries(zipPath);
    const unmanagedRels = new Set(
      unmanaged.map((abs) => relative(contentDir, abs).split(sep).join('/'))
    );
    // An unmanaged tree at the content root stores as `node_modules/...`; a
    // nested one as `force-app/.../node_modules/...`. Match the full stored
    // prefix (with or without a trailing slash, and with or without a leading
    // `./` in case a future Info-ZIP build keeps it).
    const leaked = entries.filter((e) => {
      const norm = e.replace(/^\.\//, '');
      for (const rel of unmanagedRels) {
        if (norm === rel || norm === `${rel}/` || norm.startsWith(`${rel}/`)) return true;
      }
      return false;
    });
    if (leaked.length > 0) {
      throw new Error(
        `${name}: ${leaked.length} unmanaged node_modules entr${leaked.length === 1 ? 'y' : 'ies'} ` +
          `leaked into content.zip despite the exclude (e.g. ${leaked[0]}). ` +
          `The 'zip -x' patterns did not match this host's Info-ZIP entry-name format.`
      );
    }
  }
  console.error(`  ${name} → ${outDir}/`);
}

console.error(`Built ${templates.length} template(s).`);
