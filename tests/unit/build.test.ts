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
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

vi.mock('vite', () => ({
  build: vi.fn().mockResolvedValue(undefined),
}));

import { hasReactFiles, runViteBuild } from '../../src/domain/build.js';
import { BuildError } from '../../src/errors.js';
import { build as viteBuild } from 'vite';

const mockViteBuild = vi.mocked(viteBuild);

describe('hasReactFiles', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns true when .tsx files exist', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'build-test-'));
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'src/App.tsx'), 'export default () => <div/>;');

    expect(await hasReactFiles(tmpDir)).toBe(true);
  });

  it('returns true when .jsx files exist', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'build-test-'));
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'src/App.jsx'), 'export default () => <div/>;');

    expect(await hasReactFiles(tmpDir)).toBe(true);
  });

  it('returns false when no .tsx or .jsx files exist', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'build-test-'));
    await fs.mkdir(path.join(tmpDir, 'force-app'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'force-app/meta.xml'), '<xml/>');

    expect(await hasReactFiles(tmpDir)).toBe(false);
  });

  it('returns false for an empty directory', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'build-test-'));

    expect(await hasReactFiles(tmpDir)).toBe(false);
  });
});

describe('runViteBuild', () => {
  let tmpDir: string;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('calls vite.build with correct config', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'build-test-'));
    mockViteBuild.mockResolvedValue(undefined as never);

    await runViteBuild(tmpDir);

    // doBuild resolves the project dir via fs.realpath before passing to
    // vite — on macOS that turns `/tmp/...` into `/private/tmp/...` to
    // keep rolldown happy with absolute paths. Match the resolved form.
    const resolvedTmp = await fs.realpath(tmpDir);
    expect(mockViteBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        root: resolvedTmp,
        configFile: false,
        build: expect.objectContaining({
          outDir: path.join(resolvedTmp, 'force-app/main/default/uiBundles/App/dist'),
          emptyOutDir: true,
        }),
        logLevel: 'silent',
      })
    );
  });

  it('throws BuildError when vite.build rejects', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'build-test-'));
    mockViteBuild.mockRejectedValue(new Error('Syntax error in App.tsx'));

    await expect(runViteBuild(tmpDir)).rejects.toThrow(BuildError);
    await expect(runViteBuild(tmpDir)).rejects.toThrow('Syntax error in App.tsx');
  });

  it('throws BuildError with timeout message for AbortError', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'build-test-'));
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    mockViteBuild.mockRejectedValue(abortError);

    await expect(runViteBuild(tmpDir)).rejects.toThrow(BuildError);
    await expect(runViteBuild(tmpDir)).rejects.toThrow('Build timeout after 5 minutes');
  });

  it('throws BuildError with fallback message for non-Error rejections', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'build-test-'));
    mockViteBuild.mockRejectedValue('string error');

    await expect(runViteBuild(tmpDir)).rejects.toThrow(BuildError);
    await expect(runViteBuild(tmpDir)).rejects.toThrow('Build failed');
  });
});
