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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  createBlankProject,
  createProject,
  getProjectDir,
  TemplateNotFoundError,
  ProjectNotFoundError,
} from '../../src/domain/projects.js';

describe('createProject', () => {
  let tmpDir: string;
  let templatesDir: string;
  let projectsRoot: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'projects-test-'));
    templatesDir = path.join(tmpDir, 'templates');
    projectsRoot = path.join(tmpDir, 'projects');
    await fs.mkdir(templatesDir);
    await fs.mkdir(projectsRoot);
    process.env.TEMPLATES_DIR = templatesDir;
    process.env.PROJECTS_ROOT = projectsRoot;
  });

  afterEach(async () => {
    delete process.env.TEMPLATES_DIR;
    delete process.env.PROJECTS_ROOT;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('templateId sanitization', () => {
    it('rejects path traversal with ../../etc/passwd', async () => {
      await expect(createProject('../../etc/passwd')).rejects.toThrow(TemplateNotFoundError);
    });

    it('rejects path traversal with ../foo', async () => {
      await expect(createProject('../foo')).rejects.toThrow(TemplateNotFoundError);
    });

    it('rejects slash-separated paths like foo/bar', async () => {
      await expect(createProject('foo/bar')).rejects.toThrow(TemplateNotFoundError);
    });

    it('rejects IDs with dots like foo.bar', async () => {
      await expect(createProject('foo.bar')).rejects.toThrow(TemplateNotFoundError);
    });

    it('rejects empty string', async () => {
      await expect(createProject('')).rejects.toThrow(TemplateNotFoundError);
    });

    it('rejects IDs starting with a hyphen', async () => {
      await expect(createProject('-foo')).rejects.toThrow(TemplateNotFoundError);
    });

    it('rejects IDs starting with an underscore', async () => {
      await expect(createProject('_foo')).rejects.toThrow(TemplateNotFoundError);
    });
  });

  describe('createBlankProject', () => {
    it('returns a UUID', async () => {
      const id = await createBlankProject();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it('creates sfdx-project.json with packageDirectories', async () => {
      const id = await createBlankProject();
      const configPath = path.join(projectsRoot, id, 'sfdx-project.json');
      const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
      expect(config.packageDirectories).toBeInstanceOf(Array);
      expect(config.packageDirectories.length).toBeGreaterThan(0);
    });

    it('creates force-app/main/default directory', async () => {
      const id = await createBlankProject();
      const defaultDir = path.join(projectsRoot, id, 'force-app', 'main', 'default');
      const stat = await fs.stat(defaultDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('extraction failure cleanup', () => {
    it('removes the project directory when extraction fails', async () => {
      // Write an invalid (not a zip) file as the template
      await fs.writeFile(path.join(templatesDir, 'bad-template.zip'), 'not-a-zip');

      await expect(createProject('bad-template')).rejects.toThrow();

      // The project directory should have been cleaned up
      const entries = await fs.readdir(projectsRoot);
      expect(entries).toHaveLength(0);
    });
  });

  describe('getProjectDir', () => {
    it('throws ProjectNotFoundError for invalid UUID format', async () => {
      await expect(getProjectDir('not-a-uuid')).rejects.toThrow(ProjectNotFoundError);
    });

    it('throws ProjectNotFoundError for path traversal attempts', async () => {
      await expect(getProjectDir('../../etc/passwd')).rejects.toThrow(ProjectNotFoundError);
    });

    it('throws ProjectNotFoundError when directory does not exist', async () => {
      const fakeUuid = '00000000-0000-0000-0000-000000000000';
      await expect(getProjectDir(fakeUuid)).rejects.toThrow(ProjectNotFoundError);
    });

    it('throws ProjectNotFoundError when path is not a directory', async () => {
      const fakeUuid = '00000000-0000-0000-0000-000000000001';
      // Create a file (not a directory) at the expected path
      await fs.writeFile(path.join(projectsRoot, fakeUuid), 'not-a-dir');
      await expect(getProjectDir(fakeUuid)).rejects.toThrow(ProjectNotFoundError);
    });

    it('returns the project directory path when it exists', async () => {
      const fakeUuid = '00000000-0000-0000-0000-000000000002';
      const dirPath = path.join(projectsRoot, fakeUuid);
      await fs.mkdir(dirPath, { recursive: true });
      const result = await getProjectDir(fakeUuid);
      expect(result).toBe(dirPath);
    });

    it('re-throws unexpected filesystem errors', async () => {
      const fakeUuid = '00000000-0000-0000-0000-000000000003';
      const dirPath = path.join(projectsRoot, fakeUuid);
      // Create a directory then remove read permission to trigger EACCES
      await fs.mkdir(dirPath, { recursive: true });
      await fs.chmod(projectsRoot, 0o000);

      try {
        await expect(getProjectDir(fakeUuid)).rejects.toThrow();
      } finally {
        await fs.chmod(projectsRoot, 0o755);
      }
    });
  });
});
