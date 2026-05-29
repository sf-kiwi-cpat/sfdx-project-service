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

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { dirContainsBundle, findPackageDirContainingBundle } from '../../src/domain/aab-locator.js';

describe('aab-locator', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  /** Create a directory tree: <tmpDir>/<pkgDir>/main/default/aiAuthoringBundles/<aabName>/ */
  async function makeProject(layout: { [pkgDir: string]: string[] }): Promise<string> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aab-locator-'));
    for (const [pkgDir, aabNames] of Object.entries(layout)) {
      for (const aabName of aabNames) {
        await fs.mkdir(
          path.join(tmpDir, pkgDir, 'main', 'default', 'aiAuthoringBundles', aabName),
          { recursive: true }
        );
      }
    }
    return tmpDir;
  }

  describe('dirContainsBundle', () => {
    it('returns true when aiAuthoringBundles/<name>/ exists at the given root', async () => {
      const root = await makeProject({ 'force-app': ['DataCuratorAgent'] });
      expect(dirContainsBundle(path.join(root, 'force-app'), 'DataCuratorAgent')).toBe(true);
    });

    it('returns true when the bundle is nested several levels deep', async () => {
      // Mimics the standard SFDX layout: <pkg>/main/default/aiAuthoringBundles/<name>/.
      const root = await makeProject({ 'agentforce-bundle': ['DataCuratorAgent'] });
      expect(dirContainsBundle(path.join(root, 'agentforce-bundle'), 'DataCuratorAgent')).toBe(
        true
      );
    });

    it('returns false when the directory exists but contains no aiAuthoringBundles match', async () => {
      // bundle exists, but under a different aabName than we're searching for
      const root = await makeProject({ 'force-app': ['SomeOtherAgent'] });
      expect(dirContainsBundle(path.join(root, 'force-app'), 'DataCuratorAgent')).toBe(false);
    });

    it('returns false for an aiAuthoringBundles entry that is a file rather than a directory', async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aab-locator-'));
      await fs.mkdir(path.join(tmpDir, 'force-app', 'aiAuthoringBundles'), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, 'force-app', 'aiAuthoringBundles', 'DataCuratorAgent'),
        'oops, not a directory'
      );
      expect(dirContainsBundle(path.join(tmpDir, 'force-app'), 'DataCuratorAgent')).toBe(false);
    });

    it('returns false when the directory does not exist', () => {
      expect(dirContainsBundle('/nonexistent/path/that/does/not/exist', 'Anything')).toBe(false);
    });

    it('returns false for an empty directory', async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aab-locator-'));
      expect(dirContainsBundle(tmpDir, 'DataCuratorAgent')).toBe(false);
    });
  });

  describe('findPackageDirContainingBundle', () => {
    it('returns the absolute path of the package directory containing the bundle', async () => {
      const root = await makeProject({
        'force-app': [],
        'agentforce-bundle': ['DataCuratorAgent'],
      });
      // Create force-app dir without a bundle so the iteration has to fall through it
      await fs.mkdir(path.join(root, 'force-app'), { recursive: true });
      const result = findPackageDirContainingBundle(
        [path.join(root, 'force-app'), path.join(root, 'agentforce-bundle')],
        'DataCuratorAgent'
      );
      expect(result).toBe(path.join(root, 'agentforce-bundle'));
    });

    it('returns the first matching package directory when multiple contain the bundle', async () => {
      // The current data-curator layout has the bundle under both force-app/ (untracked
      // CLI byproduct) and agentforce-bundle/ (canonical). The locator picks whichever
      // appears first in the package-directory list — test that determinism explicitly.
      const root = await makeProject({
        'force-app': ['DataCuratorAgent'],
        'agentforce-bundle': ['DataCuratorAgent'],
      });
      const result = findPackageDirContainingBundle(
        [path.join(root, 'force-app'), path.join(root, 'agentforce-bundle')],
        'DataCuratorAgent'
      );
      expect(result).toBe(path.join(root, 'force-app'));
    });

    it('returns undefined when no package directory contains the bundle', async () => {
      const root = await makeProject({ 'force-app': ['SomeOtherAgent'] });
      const result = findPackageDirContainingBundle(
        [path.join(root, 'force-app')],
        'DataCuratorAgent'
      );
      expect(result).toBeUndefined();
    });

    it('returns undefined for an empty packageDirsAbs list', () => {
      expect(findPackageDirContainingBundle([], 'DataCuratorAgent')).toBeUndefined();
    });

    it('skips package directories that do not exist on disk', async () => {
      const root = await makeProject({ 'agentforce-bundle': ['DataCuratorAgent'] });
      const result = findPackageDirContainingBundle(
        [path.join(root, 'never-existed'), path.join(root, 'agentforce-bundle')],
        'DataCuratorAgent'
      );
      expect(result).toBe(path.join(root, 'agentforce-bundle'));
    });
  });
});
