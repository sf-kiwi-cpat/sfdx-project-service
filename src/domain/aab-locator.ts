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
 */
export function dirContainsBundle(dir: string, aabName: string): boolean {
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
    const child = path.join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(child).isDirectory();
    } catch {
      continue;
    }
    if (isDir && dirContainsBundle(child, aabName)) {
      return true;
    }
  }
  return false;
}
