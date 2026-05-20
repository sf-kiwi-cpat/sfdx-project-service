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
import {
  generateAppNameToken,
  uniquifyAppNames,
  findBundleDir,
} from '../../src/domain/app-naming.js';

const UI_BUNDLES_REL = 'force-app/main/default/uiBundles';
const APPLICATIONS_REL = 'force-app/main/default/applications';
const DEVELOPER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

/**
 * Stage a fake project directory with an `App` UIBundle and (optionally)
 * a CustomApplication file. Mirrors what extract-zip produces from a
 * built-in template so the unit tests exercise the same shape as
 * production without paying for a real template extraction.
 */
async function stageFakeProject(
  opts: {
    withCustomApp?: { name: string };
  } = {}
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-naming-test-'));
  const bundleDir = path.join(dir, UI_BUNDLES_REL, 'App');
  await fs.mkdir(bundleDir, { recursive: true });
  await fs.writeFile(
    path.join(bundleDir, 'App.uibundle-meta.xml'),
    '<?xml version="1.0"?><UIBundle/>'
  );
  await fs.writeFile(path.join(bundleDir, 'index.html'), '<html/>');

  if (opts.withCustomApp) {
    const appsDir = path.join(dir, APPLICATIONS_REL);
    await fs.mkdir(appsDir, { recursive: true });
    await fs.writeFile(
      path.join(appsDir, `${opts.withCustomApp.name}.app-meta.xml`),
      '<?xml version="1.0"?><CustomApplication/>'
    );
  }
  return dir;
}

describe('generateAppNameToken', () => {
  it('returns a token that is a valid DeveloperName segment', () => {
    const token = generateAppNameToken();
    // 8 hex chars; safe to suffix any DeveloperName-prefix.
    expect(token).toMatch(/^[a-f0-9]{8}$/);
  });

  it('returns distinct tokens on consecutive calls', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) tokens.add(generateAppNameToken());
    // 100 randomUUID-derived tokens with 32 bits of entropy each — birthday
    // collisions are theoretically possible at ~65k samples, not 100. Any
    // duplicate here means the generator is broken, not unlucky.
    expect(tokens.size).toBe(100);
  });
});

describe('uniquifyAppNames', () => {
  let projectDir: string;

  afterEach(async () => {
    if (projectDir) {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it('renames the UIBundle directory and meta file with the token suffix', async () => {
    projectDir = await stageFakeProject();
    const token = await uniquifyAppNames(projectDir, 'abc12345');

    expect(token).toBe('abc12345');
    const bundlesRoot = path.join(projectDir, UI_BUNDLES_REL);
    const entries = await fs.readdir(bundlesRoot);
    expect(entries).toEqual(['App_abc12345']);

    const inside = await fs.readdir(path.join(bundlesRoot, 'App_abc12345'));
    expect(inside).toContain('App_abc12345.uibundle-meta.xml');
    expect(inside).toContain('index.html');
    expect(inside).not.toContain('App.uibundle-meta.xml');
  });

  it('renames the CustomApplication file when one exists', async () => {
    projectDir = await stageFakeProject({ withCustomApp: { name: 'Data_Curator' } });
    await uniquifyAppNames(projectDir, 'abc12345');

    const apps = await fs.readdir(path.join(projectDir, APPLICATIONS_REL));
    expect(apps).toEqual(['Data_Curator_abc12345.app-meta.xml']);
  });

  it('uses generated token when none provided', async () => {
    projectDir = await stageFakeProject();
    const token = await uniquifyAppNames(projectDir);
    expect(token).toMatch(/^[a-f0-9]{8}$/);

    const entries = await fs.readdir(path.join(projectDir, UI_BUNDLES_REL));
    expect(entries[0]).toBe(`App_${token}`);
    expect(entries[0]).toMatch(DEVELOPER_NAME_PATTERN);
  });

  it('two projects from the same template get different bundle names', async () => {
    const a = await stageFakeProject();
    const b = await stageFakeProject();
    try {
      const tokenA = await uniquifyAppNames(a);
      const tokenB = await uniquifyAppNames(b);
      expect(tokenA).not.toBe(tokenB);

      const aBundle = (await fs.readdir(path.join(a, UI_BUNDLES_REL)))[0];
      const bBundle = (await fs.readdir(path.join(b, UI_BUNDLES_REL)))[0];
      expect(aBundle).not.toBe(bBundle);
    } finally {
      await fs.rm(a, { recursive: true, force: true });
      await fs.rm(b, { recursive: true, force: true });
    }
  });

  it('two projects from a template with a CustomApplication get different app names', async () => {
    const a = await stageFakeProject({ withCustomApp: { name: 'Data_Curator' } });
    const b = await stageFakeProject({ withCustomApp: { name: 'Data_Curator' } });
    try {
      await uniquifyAppNames(a);
      await uniquifyAppNames(b);

      const aApp = (await fs.readdir(path.join(a, APPLICATIONS_REL)))[0];
      const bApp = (await fs.readdir(path.join(b, APPLICATIONS_REL)))[0];
      expect(aApp).not.toBe(bApp);
      expect(aApp.startsWith('Data_Curator_')).toBe(true);
      expect(bApp.startsWith('Data_Curator_')).toBe(true);
    } finally {
      await fs.rm(a, { recursive: true, force: true });
      await fs.rm(b, { recursive: true, force: true });
    }
  });

  it('is a no-op on a project with no UIBundle directory', async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-naming-empty-'));
    const token = await uniquifyAppNames(projectDir, 'abc12345');
    // Returns the token even if nothing was renamed — caller persists it.
    expect(token).toBe('abc12345');
  });

  it('is a no-op when the bundles directory exists but is empty', async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-naming-empty-bundles-'));
    await fs.mkdir(path.join(projectDir, UI_BUNDLES_REL), { recursive: true });
    const token = await uniquifyAppNames(projectDir, 'abc12345');
    expect(token).toBe('abc12345');

    const entries = await fs.readdir(path.join(projectDir, UI_BUNDLES_REL));
    expect(entries).toEqual([]);
  });

  it('does not rename when bundle directory has multiple children (out-of-scope case)', async () => {
    // Multi-bundle templates are explicitly out of scope per
    // spec/app-naming/contract.md. The implementation must not silently
    // rename one of them, which would be a half-uniquification.
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-naming-multi-'));
    const root = path.join(projectDir, UI_BUNDLES_REL);
    await fs.mkdir(path.join(root, 'AppOne'), { recursive: true });
    await fs.mkdir(path.join(root, 'AppTwo'), { recursive: true });

    await uniquifyAppNames(projectDir, 'abc12345');

    const entries = (await fs.readdir(root)).sort();
    expect(entries).toEqual(['AppOne', 'AppTwo']);
  });

  it('rewrites manifest/package.xml members for renamed UIBundle and CustomApplication', async () => {
    projectDir = await stageFakeProject({ withCustomApp: { name: 'Data_Curator' } });
    // Add a manifest that names the renamed components.
    await fs.mkdir(path.join(projectDir, 'manifest'), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, 'manifest/package.xml'),
      '<?xml version="1.0"?>\n' +
        '<Package>\n' +
        '  <types><members>App</members><name>UIBundle</name></types>\n' +
        '  <types><members>Data_Curator</members><name>CustomApplication</name></types>\n' +
        '  <types><members>SomeUnrelatedClass</members><name>ApexClass</name></types>\n' +
        '</Package>\n'
    );

    await uniquifyAppNames(projectDir, 'abc12345');

    const manifest = await fs.readFile(path.join(projectDir, 'manifest/package.xml'), 'utf-8');
    expect(manifest).toContain('<members>App_abc12345</members>');
    expect(manifest).toContain('<members>Data_Curator_abc12345</members>');
    // Unrelated members must be left alone.
    expect(manifest).toContain('<members>SomeUnrelatedClass</members>');
    // Old names must not remain.
    expect(manifest).not.toMatch(/<members>App<\/members>/);
    expect(manifest).not.toMatch(/<members>Data_Curator<\/members>/);
  });

  it('does not write the manifest when nothing was renamed', async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-naming-no-rename-'));
    const manifestDir = path.join(projectDir, 'manifest');
    await fs.mkdir(manifestDir, { recursive: true });
    const original = '<?xml version="1.0"?><Package/>\n';
    await fs.writeFile(path.join(manifestDir, 'package.xml'), original);

    await uniquifyAppNames(projectDir, 'abc12345');

    const manifest = await fs.readFile(path.join(manifestDir, 'package.xml'), 'utf-8');
    expect(manifest).toBe(original);
  });

  it('tolerates a UIBundle directory that lacks the expected meta file', async () => {
    // If a template ships a bundle directory but no `<name>.uibundle-meta.xml`
    // inside, the rename of the directory still proceeds. The missing meta
    // file is a template authoring bug, surfaced later by SDR — not the
    // uniquification step's concern.
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-naming-no-meta-'));
    const bundle = path.join(projectDir, UI_BUNDLES_REL, 'App');
    await fs.mkdir(bundle, { recursive: true });
    await fs.writeFile(path.join(bundle, 'index.html'), '<html/>');

    await expect(uniquifyAppNames(projectDir, 'abc12345')).resolves.toBe('abc12345');
    const entries = await fs.readdir(path.join(projectDir, UI_BUNDLES_REL));
    expect(entries).toEqual(['App_abc12345']);
  });
});

describe('findBundleDir', () => {
  let projectDir: string;

  afterEach(async () => {
    if (projectDir) {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it('returns the single bundle directory name', async () => {
    projectDir = await stageFakeProject();
    expect(await findBundleDir(projectDir)).toBe('App');
  });

  it('returns undefined when no bundles directory exists', async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'no-bundles-'));
    expect(await findBundleDir(projectDir)).toBeUndefined();
  });

  it('returns undefined when the bundles directory has multiple entries', async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'multi-bundles-'));
    const root = path.join(projectDir, UI_BUNDLES_REL);
    await fs.mkdir(path.join(root, 'AppOne'), { recursive: true });
    await fs.mkdir(path.join(root, 'AppTwo'), { recursive: true });
    expect(await findBundleDir(projectDir)).toBeUndefined();
  });
});
