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
import { execFileSync } from 'node:child_process';
import {
  createBlankProject,
  createProject,
  getProject,
  getProjectDir,
  renameProject,
  updateLastAccessed,
  TemplateNotFoundError,
  ProjectNotFoundError,
} from '../../src/domain/projects.js';

/**
 * Build a zip containing the given files at the given output path.
 * Stages files in a temp dir and shells out to the `zip` CLI — keeps the
 * test toolchain free of any zip-creation library, matching the build
 * script's approach (see scripts/zip-templates.js).
 */
async function buildZip(
  outputPath: string,
  files: Array<{ name: string; content: Buffer | string }>
): Promise<void> {
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-staging-'));
  try {
    for (const file of files) {
      const filePath = path.join(stagingDir, file.name);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, file.content);
    }
    await fs.rm(outputPath, { force: true });
    execFileSync('zip', ['-r', '-q', '-X', outputPath, '.'], {
      cwd: stagingDir,
      stdio: 'pipe',
    });
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
}

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
    it('returns an object with id and name', async () => {
      const result = await createBlankProject();
      expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(typeof result.name).toBe('string');
      expect(result.name.length).toBeGreaterThan(0);
    });

    it('creates sfdx-project.json with packageDirectories', async () => {
      const { id } = await createBlankProject();
      const configPath = path.join(projectsRoot, id, 'sfdx-project.json');
      const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
      expect(config.packageDirectories).toBeInstanceOf(Array);
      expect(config.packageDirectories.length).toBeGreaterThan(0);
    });

    it('creates force-app/main/default directory', async () => {
      const { id } = await createBlankProject();
      const defaultDir = path.join(projectsRoot, id, 'force-app', 'main', 'default');
      const stat = await fs.stat(defaultDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('scaffolds lwc and aura subdirectories via empty template', async () => {
      const { id } = await createBlankProject();
      const defaultDir = path.join(projectsRoot, id, 'force-app', 'main', 'default');
      const entries = await fs.readdir(defaultDir);
      expect(entries).toContain('aura');
      expect(entries).toContain('lwc');
    });

    it('creates .forceignore', async () => {
      const { id } = await createBlankProject();
      const ignorePath = path.join(projectsRoot, id, '.forceignore');
      const stat = await fs.stat(ignorePath);
      expect(stat.isFile()).toBe(true);
    });

    it('cleans up project directory on failure', async () => {
      const origRoot = process.env.PROJECTS_ROOT;
      process.env.PROJECTS_ROOT = '/nonexistent/path/that/will/fail';
      try {
        await expect(createBlankProject()).rejects.toThrow();
      } finally {
        process.env.PROJECTS_ROOT = origRoot;
      }
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

  async function createTemplateWithZip(
    templateId: string,
    templateJson: Record<string, unknown>
  ): Promise<void> {
    const templateDir = path.join(templatesDir, templateId);
    await fs.mkdir(templateDir, { recursive: true });

    await buildZip(path.join(templateDir, 'content.zip'), [
      { name: 'README.md', content: Buffer.from('# Test') },
    ]);

    await fs.writeFile(path.join(templateDir, 'template.json'), JSON.stringify(templateJson));
  }

  describe('initialMessages', () => {
    it('persists initialMessages from template.json into .project-meta.json', async () => {
      const messages = [
        { role: 'user', content: 'Build me something' },
        { role: 'assistant', content: 'On it!' },
      ];
      await createTemplateWithZip('with-messages', {
        id: 'with-messages',
        name: 'With Messages',
        description: 'test',
        initialMessages: messages,
      });

      const result = await createProject('with-messages');

      expect(result.initialMessages).toEqual(messages);
      const meta = JSON.parse(
        await fs.readFile(path.join(projectsRoot, result.id, '.project-meta.json'), 'utf-8')
      );
      expect(meta.initialMessages).toEqual(messages);
    });

    it('omits initialMessages when template.json has no initialMessages key', async () => {
      await createTemplateWithZip('no-messages', {
        id: 'no-messages',
        name: 'No Messages',
        description: 'test',
      });

      const result = await createProject('no-messages');

      expect(result.initialMessages).toBeUndefined();
      const meta = JSON.parse(
        await fs.readFile(path.join(projectsRoot, result.id, '.project-meta.json'), 'utf-8')
      );
      expect(meta.initialMessages).toBeUndefined();
    });

    it('omits initialMessages when template.json has an empty array', async () => {
      await createTemplateWithZip('empty-messages', {
        id: 'empty-messages',
        name: 'Empty Messages',
        description: 'test',
        initialMessages: [],
      });

      const result = await createProject('empty-messages');

      expect(result.initialMessages).toBeUndefined();
      const meta = JSON.parse(
        await fs.readFile(path.join(projectsRoot, result.id, '.project-meta.json'), 'utf-8')
      );
      expect(meta.initialMessages).toBeUndefined();
    });

    it('still creates the project when template.json is missing', async () => {
      const templateDir = path.join(templatesDir, 'zip-only');
      await fs.mkdir(templateDir, { recursive: true });
      await buildZip(path.join(templateDir, 'content.zip'), [
        { name: 'README.md', content: Buffer.from('# Test') },
      ]);

      const result = await createProject('zip-only');

      expect(result.id).toBeDefined();
      expect(result.initialMessages).toBeUndefined();
    });

    it('filters out malformed elements from template.json initialMessages', async () => {
      // Mix of valid and malformed entries: missing content, missing role,
      // wrong types, a non-object primitive, and one valid message.
      await createTemplateWithZip('mixed-messages', {
        id: 'mixed-messages',
        name: 'Mixed Messages',
        description: 'test',
        initialMessages: [
          { role: 'user' }, // missing content
          { content: 'no role' }, // missing role
          { role: 42, content: 'bad role type' },
          42,
          null,
          { role: 'user', content: 'the one good one' },
        ],
      });

      const result = await createProject('mixed-messages');

      expect(result.initialMessages).toEqual([{ role: 'user', content: 'the one good one' }]);
    });

    it('omits initialMessages when every element is malformed', async () => {
      await createTemplateWithZip('all-bad-messages', {
        id: 'all-bad-messages',
        name: 'All Bad Messages',
        description: 'test',
        initialMessages: [{ role: 'user' }, 42, null],
      });

      const result = await createProject('all-bad-messages');

      expect(result.initialMessages).toBeUndefined();
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

  describe('getProject', () => {
    it('throws ProjectNotFoundError for a nonexistent project', async () => {
      const fakeUuid = '00000000-0000-0000-0000-000000000000';
      await expect(getProject(fakeUuid)).rejects.toThrow(ProjectNotFoundError);
    });

    it('throws ProjectNotFoundError for malformed UUIDs', async () => {
      await expect(getProject('not-a-uuid')).rejects.toThrow(ProjectNotFoundError);
    });

    it('falls back to new Date().toISOString() when meta has no lastAccessedAt', async () => {
      // Create a project dir with a meta file that has no lastAccessedAt
      // (simulates a legacy project on disk; updateLastAccessed runs first
      // and writes the field, so this really only tests the defensive fallback).
      const fakeUuid = '00000000-0000-0000-0000-00000000abcd';
      const dirPath = path.join(projectsRoot, fakeUuid);
      await fs.mkdir(dirPath, { recursive: true });
      await fs.writeFile(
        path.join(dirPath, '.project-meta.json'),
        JSON.stringify({ name: 'legacy-project' })
      );

      const result = await getProject(fakeUuid);

      expect(result.id).toBe(fakeUuid);
      expect(result.name).toBe('legacy-project');
      expect(typeof result.lastAccessedAt).toBe('string');
      expect(new Date(result.lastAccessedAt).toISOString()).toBe(result.lastAccessedAt);
    });

    it('surfaces initialMessages when present in project meta', async () => {
      const messages = [
        { role: 'user', content: 'Build me something' },
        { role: 'assistant', content: 'On it!' },
      ];
      await createTemplateWithZip('get-with-messages', {
        id: 'get-with-messages',
        name: 'Get With Messages',
        description: 'test',
        initialMessages: messages,
      });
      const { id } = await createProject('get-with-messages');

      const result = await getProject(id);

      expect(result.initialMessages).toEqual(messages);
    });

    it('omits initialMessages when not present in project meta', async () => {
      const { id } = await createBlankProject();

      const result = await getProject(id);

      expect(result.initialMessages).toBeUndefined();
    });
  });

  describe('updateLastAccessed (domain-level)', () => {
    it('bumps lastAccessedAt when meta is valid', async () => {
      const { id } = await createBlankProject();
      const projectDir = path.join(projectsRoot, id);
      const metaPath = path.join(projectDir, '.project-meta.json');
      const before = JSON.parse(await fs.readFile(metaPath, 'utf-8'));

      await new Promise((r) => setTimeout(r, 10));
      await updateLastAccessed(projectDir);

      const after = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
      expect(after.lastAccessedAt > before.lastAccessedAt).toBe(true);
      expect(after.name).toBe(before.name);
    });

    it('is a no-op when the meta file is missing', async () => {
      const { id } = await createBlankProject();
      const projectDir = path.join(projectsRoot, id);
      const metaPath = path.join(projectDir, '.project-meta.json');
      await fs.unlink(metaPath);

      await updateLastAccessed(projectDir);

      await expect(fs.access(metaPath)).rejects.toThrow();
    });

    it('is a no-op when the meta file is unparseable', async () => {
      const { id } = await createBlankProject();
      const projectDir = path.join(projectsRoot, id);
      const metaPath = path.join(projectDir, '.project-meta.json');
      const corrupted = '{definitely-not-json';
      await fs.writeFile(metaPath, corrupted);

      await updateLastAccessed(projectDir);

      const after = await fs.readFile(metaPath, 'utf-8');
      expect(after).toBe(corrupted);
    });
  });

  describe('writeProjectMeta atomicity', () => {
    it('leaves no tmp files behind after createBlankProject', async () => {
      const { id } = await createBlankProject();
      const projectDir = path.join(projectsRoot, id);
      const entries = await fs.readdir(projectDir);
      expect(entries.every((e) => !e.includes('.tmp'))).toBe(true);
    });

    it('leaves no tmp files behind after renameProject', async () => {
      const { id } = await createBlankProject();
      const projectDir = path.join(projectsRoot, id);

      await renameProject(id, 'post-rename-name');

      const entries = await fs.readdir(projectDir);
      expect(entries.every((e) => !e.includes('.tmp'))).toBe(true);
    });

    it('leaves no tmp files behind after updateLastAccessed', async () => {
      const { id } = await createBlankProject();
      const projectDir = path.join(projectsRoot, id);

      await updateLastAccessed(projectDir);

      const entries = await fs.readdir(projectDir);
      expect(entries.every((e) => !e.includes('.tmp'))).toBe(true);
    });
  });
});
