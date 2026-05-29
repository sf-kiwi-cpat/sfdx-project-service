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

/**
 * On-disk lookup helper for the publish-aab child process.
 *
 * Lives in its own module so the helpers can be unit-tested without
 * importing `@salesforce/agents` (which has the nock side-effect we
 * isolate via the child process — see `publish-aab-child.ts` header).
 *
 * The helpers exist because `@salesforce/agents@1.6.x`'s
 * `scriptAgentPublisher.validateDeveloperName()` only searches
 * `getDefaultPackage()` for the bundle. Templates that legitimately
 * keep `aiAuthoringBundles/` under a non-default `packageDirectory`
 * (e.g. data-curator's `agentforce-bundle/`) cannot be published
 * without a workaround — even though the metadata-API deploy happily
 * resolves bundles from any declared package dir.
 *
 * Once @salesforce/agents searches all `packageDirectories` (or the
 * caller of `Agent.init` is allowed to specify a search root other
 * than the default package), this module can be deleted.
 */

import path from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';

/**
 * Directories we never descend into while hunting for a bundle. None of
 * these can legitimately contain a DX `aiAuthoringBundles/` source tree,
 * and they're exactly the trees that make an unbounded walk expensive
 * (a vendored `node_modules` under a package root, VCS/CLI metadata).
 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.sf', '.sfdx', '.localdevserver']);

/**
 * Depth ceiling for the recursive walk. SFDX bundles live at a fixed,
 * shallow depth under a package directory
 * (`<pkg>/main/default/aiAuthoringBundles/<name>/` — 3 levels), so 6 is
 * generous for any real DX layout while bounding the walk on projects
 * that symlink or nest deeply. Reaching the limit returns false rather
 * than throwing — same fail-soft contract as an I/O error.
 */
const MAX_WALK_DEPTH = 6;

/**
 * Walk every package directory looking for an `aiAuthoringBundles/<aabName>/`
 * directory anywhere inside it. Returns the package directory's absolute
 * path on disk if a match is found, undefined otherwise.
 *
 * Callers are expected to pass the absolute path of every declared
 * `packageDirectory` from `sfdx-project.json`. We don't take an
 * `SfProject` here so this module can be unit-tested without
 * `@salesforce/core`.
 */
export function findPackageDirContainingBundle(
  packageDirsAbs: readonly string[],
  aabName: string
): string | undefined {
  for (const dirAbs of packageDirsAbs) {
    if (dirContainsBundle(dirAbs, aabName)) {
      return dirAbs;
    }
  }
  return undefined;
}

/**
 * Recursively check whether `dir` (or any directory underneath it)
 * contains an `aiAuthoringBundles/<aabName>/` subdirectory.
 *
 * Mirrors `@salesforce/agents` `findAuthoringBundle` helper's traversal
 * (descend until a child directory named `aiAuthoringBundles` is hit,
 * then check whether `<aabName>` exists inside it). Returns false on any
 * I/O error so callers don't have to wrap each call in a try/catch.
 *
 * The walk skips well-known non-source trees (`node_modules`, `.git`,
 * …) and is bounded by `MAX_WALK_DEPTH` so a deeply nested or vendored
 * package directory can't make it expensive or blow the stack. `depth`
 * is an internal recursion accumulator; callers pass two args.
 */
export function dirContainsBundle(dir: string, aabName: string, depth = 0): boolean {
  if (depth > MAX_WALK_DEPTH) {
    return false;
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  if (entries.includes('aiAuthoringBundles')) {
    const candidate = path.join(dir, 'aiAuthoringBundles', aabName);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return true;
    }
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) {
      continue;
    }
    const child = path.join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(child).isDirectory();
    } catch {
      continue;
    }
    if (isDir && dirContainsBundle(child, aabName, depth + 1)) {
      return true;
    }
  }
  return false;
}
