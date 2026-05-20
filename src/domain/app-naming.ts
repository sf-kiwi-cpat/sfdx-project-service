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

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const UI_BUNDLES_REL = 'force-app/main/default/uiBundles';
const APPLICATIONS_REL = 'force-app/main/default/applications';
const MANIFEST_DIR_REL = 'manifest';

/**
 * Generate a per-project token used to suffix singular-shipped metadata
 * DeveloperNames so concurrent deploys to the same Salesforce org don't
 * collide. 8 hex chars give ~4B distinct values; collision probability
 * across realistic project counts is negligible. Format is a valid
 * Salesforce DeveloperName segment (alphanumeric, no hyphens).
 */
export function generateAppNameToken(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

/**
 * Suffix every singular-shipped metadata DeveloperName in a freshly-extracted
 * project with `_<token>`. Affects:
 *
 *   - `force-app/main/default/uiBundles/<name>/` — directory + the meta file
 *     inside it (`<name>.uibundle-meta.xml`).
 *   - `force-app/main/default/applications/<name>.app-meta.xml` — file rename.
 *
 * The bundle's internal contents (index.html, src/, vite.config.ts, etc.)
 * use relative paths; renaming the parent directory does not require any
 * content edits. The XML metadata files have no `<fullName>` element —
 * Salesforce derives `fullName` from the filename — so renaming the file
 * is sufficient.
 *
 * Idempotency is the caller's responsibility: persist `token` in
 * `.project-meta.json` and skip this call on subsequent builds.
 *
 * Returns the token used so the caller can persist it. If the project
 * does not contain any of the singular-shipped metadata directories
 * (e.g. blank project), this is a no-op and still returns the token.
 */
export async function uniquifyAppNames(
  projectDir: string,
  token: string = generateAppNameToken()
): Promise<string> {
  const oldBundleName = await renameSingularBundleDir(path.join(projectDir, UI_BUNDLES_REL), token);
  const renamedApps = await renameSingularApplicationFile(
    path.join(projectDir, APPLICATIONS_REL),
    token
  );
  // Manifests under `manifest/` reference metadata DeveloperNames by
  // old value; rewrite them to point at the new names so SDR's
  // ComponentSet.fromManifest resolves correctly. Templates with
  // multiple stages (deployStages in template.json) ship multiple
  // package.xml-style files in this directory.
  await rewriteManifestMembers(
    path.join(projectDir, MANIFEST_DIR_REL),
    oldBundleName,
    renamedApps,
    token
  );
  return token;
}

/**
 * Rename the single UIBundle directory and its meta file. Returns the
 * pre-rename bundle name (or undefined if no rename happened) so callers
 * can rewrite manifest references.
 */
async function renameSingularBundleDir(
  uiBundlesRoot: string,
  token: string
): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await fs.readdir(uiBundlesRoot);
  } catch {
    return undefined;
  }
  if (entries.length !== 1) return undefined;
  const oldName = entries[0];
  const newName = `${oldName}_${token}`;
  const oldDir = path.join(uiBundlesRoot, oldName);
  const newDir = path.join(uiBundlesRoot, newName);
  await fs.rename(oldDir, newDir);

  const oldMeta = path.join(newDir, `${oldName}.uibundle-meta.xml`);
  const newMeta = path.join(newDir, `${newName}.uibundle-meta.xml`);
  try {
    await fs.rename(oldMeta, newMeta);
  } catch {
    // If the meta file is missing the bundle is malformed; the deploy
    // will surface that error with better context than we could here.
  }
  return oldName;
}

/**
 * Rename `<name>.app-meta.xml` files. Returns the list of pre-rename
 * DeveloperNames so callers can rewrite manifest references.
 */
async function renameSingularApplicationFile(
  applicationsRoot: string,
  token: string
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(applicationsRoot);
  } catch {
    return [];
  }
  const renamed: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.app-meta.xml')) continue;
    const base = entry.replace(/\.app-meta\.xml$/, '');
    const newName = `${base}_${token}.app-meta.xml`;
    await fs.rename(path.join(applicationsRoot, entry), path.join(applicationsRoot, newName));
    renamed.push(base);
  }
  return renamed;
}

/**
 * Rewrite manifest/package.xml `<members>` entries that name renamed
 * UIBundles or CustomApplications. SDR's ComponentSet.fromManifest
 * matches manifest members against on-disk DeveloperNames, so a stale
 * manifest references a non-existent component and falls back to
 * full-project scanning (which surfaces unrelated SDR validation errors).
 *
 * Only rewrites the specific member values we renamed — not a blanket
 * find-and-replace, which could clobber unrelated occurrences of the
 * same string elsewhere in the manifest.
 */
async function rewriteManifestMembers(
  manifestDir: string,
  oldBundleName: string | undefined,
  renamedApps: string[],
  token: string
): Promise<void> {
  if (!oldBundleName && renamedApps.length === 0) return;
  let entries: string[];
  try {
    entries = await fs.readdir(manifestDir);
  } catch {
    // No manifest dir — single-pass deploy will use ComponentSet.fromSource
    // which doesn't read the manifest. Nothing to rewrite.
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.xml')) continue;
    const manifestPath = path.join(manifestDir, entry);
    const xml = await fs.readFile(manifestPath, 'utf-8');
    let updated = xml;
    if (oldBundleName) {
      const exact = new RegExp(`<members>${oldBundleName}</members>`, 'g');
      updated = updated.replace(exact, `<members>${oldBundleName}_${token}</members>`);
    }
    for (const app of renamedApps) {
      const exact = new RegExp(`<members>${app}</members>`, 'g');
      updated = updated.replace(exact, `<members>${app}_${token}</members>`);
    }
    if (updated !== xml) {
      await fs.writeFile(manifestPath, updated);
    }
  }
}

/**
 * Find the single UIBundle directory under a project, or undefined if
 * the project ships no bundle. Used by the build pipeline to resolve the
 * per-project bundle name without coupling to a literal.
 */
export async function findBundleDir(projectDir: string): Promise<string | undefined> {
  const uiBundlesRoot = path.join(projectDir, UI_BUNDLES_REL);
  let entries: string[];
  try {
    entries = await fs.readdir(uiBundlesRoot);
  } catch {
    return undefined;
  }
  if (entries.length !== 1) return undefined;
  return entries[0];
}
