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
// The script is plain JS and exports `requireZipCli` for shared use.
// @ts-expect-error — JS module without an .d.ts shim; test-only import.
import { requireZipCli } from '../../scripts/lib/require-zip-cli.js';

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
  // Surface the actionable "zip CLI not on PATH" message via a thrown
  // error instead of the bare ENOENT execFileSync would produce.
  // Idempotent — see scripts/lib/require-zip-cli.js — so calling it
  // here per buildZip() invocation is cheap.
  requireZipCli();
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
      expect(result.name).toBe('Untitled');
    });

    it('numbers subsequent blank projects: Untitled, Untitled 2, Untitled 3', async () => {
      const a = await createBlankProject();
      const b = await createBlankProject();
      const c = await createBlankProject();
      expect(a.name).toBe('Untitled');
      expect(b.name).toBe('Untitled 2');
      expect(c.name).toBe('Untitled 3');
    });

    it('does not collide with an existing numbered slot after a middle rename', async () => {
      // {Untitled, Untitled 2, Untitled 3} → rename Untitled 2 → {Untitled, Untitled 3}.
      // Naive "count + 1" returns 3, colliding. Max + 1 returns 4.
      const a = await createBlankProject();
      const b = await createBlankProject();
      await createBlankProject();
      await renameProject(b.id, 'My App');
      const d = await createBlankProject();
      expect(a.name).toBe('Untitled');
      expect(d.name).toBe('Untitled 4');
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

  describe('seedMessages', () => {
    it('persists seedMessages from template.json into .project-meta.json', async () => {
      const messages = [
        { role: 'user', content: 'Anchor the persona' },
        { role: 'assistant', content: 'Anchored.' },
      ];
      await createTemplateWithZip('with-seeds', {
        id: 'with-seeds',
        name: 'With Seeds',
        description: 'test',
        seedMessages: messages,
      });

      const result = await createProject('with-seeds');

      expect(result.seedMessages).toEqual(messages);
      const meta = JSON.parse(
        await fs.readFile(path.join(projectsRoot, result.id, '.project-meta.json'), 'utf-8')
      );
      expect(meta.seedMessages).toEqual(messages);
    });

    it('omits seedMessages when template.json has no seedMessages key', async () => {
      await createTemplateWithZip('no-seeds', {
        id: 'no-seeds',
        name: 'No Seeds',
        description: 'test',
      });

      const result = await createProject('no-seeds');

      expect(result.seedMessages).toBeUndefined();
      const meta = JSON.parse(
        await fs.readFile(path.join(projectsRoot, result.id, '.project-meta.json'), 'utf-8')
      );
      expect(meta.seedMessages).toBeUndefined();
    });

    it('omits seedMessages when template.json has an empty array', async () => {
      await createTemplateWithZip('empty-seeds', {
        id: 'empty-seeds',
        name: 'Empty Seeds',
        description: 'test',
        seedMessages: [],
      });

      const result = await createProject('empty-seeds');

      expect(result.seedMessages).toBeUndefined();
    });

    it('filters out malformed elements from template.json seedMessages', async () => {
      await createTemplateWithZip('mixed-seeds', {
        id: 'mixed-seeds',
        name: 'Mixed Seeds',
        description: 'test',
        seedMessages: [
          { role: 'user' }, // missing content
          { content: 'no role' }, // missing role
          { role: 42, content: 'bad role type' },
          42,
          null,
          { role: 'assistant', content: 'the one good seed' },
        ],
      });

      const result = await createProject('mixed-seeds');

      expect(result.seedMessages).toEqual([{ role: 'assistant', content: 'the one good seed' }]);
    });

    it('omits seedMessages when every element is malformed', async () => {
      await createTemplateWithZip('all-bad-seeds', {
        id: 'all-bad-seeds',
        name: 'All Bad Seeds',
        description: 'test',
        seedMessages: [{ role: 'user' }, 42, null],
      });

      const result = await createProject('all-bad-seeds');

      expect(result.seedMessages).toBeUndefined();
    });

    it('drops a seed whose content exceeds the 10k-char cap, keeping valid ones', async () => {
      const oversized = 'x'.repeat(10_001);
      await createTemplateWithZip('oversized-seeds', {
        id: 'oversized-seeds',
        name: 'Oversized Seeds',
        description: 'test',
        seedMessages: [
          { role: 'user', content: oversized },
          { role: 'assistant', content: 'kept' },
        ],
      });

      const result = await createProject('oversized-seeds');

      expect(result.seedMessages).toEqual([{ role: 'assistant', content: 'kept' }]);
    });

    it('keeps a seed whose content is exactly at the 10k-char cap', async () => {
      const atCap = 'y'.repeat(10_000);
      await createTemplateWithZip('atcap-seeds', {
        id: 'atcap-seeds',
        name: 'At Cap Seeds',
        description: 'test',
        seedMessages: [{ role: 'user', content: atCap }],
      });

      const result = await createProject('atcap-seeds');

      expect(result.seedMessages).toEqual([{ role: 'user', content: atCap }]);
    });

    it('caps seedMessages at 50 entries, truncating the surplus', async () => {
      const many = Array.from({ length: 60 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `turn ${i}`,
      }));
      await createTemplateWithZip('many-seeds', {
        id: 'many-seeds',
        name: 'Many Seeds',
        description: 'test',
        seedMessages: many,
      });

      const result = await createProject('many-seeds');

      expect(result.seedMessages).toHaveLength(50);
      expect(result.seedMessages).toEqual(many.slice(0, 50));
    });

    it('captures initialMessages and seedMessages independently when a template declares both', async () => {
      const initial = [{ role: 'user', content: 'visible opener' }];
      const seeds = [{ role: 'assistant', content: 'hidden anchor' }];
      await createTemplateWithZip('both-fields', {
        id: 'both-fields',
        name: 'Both Fields',
        description: 'test',
        initialMessages: initial,
        seedMessages: seeds,
      });

      const result = await createProject('both-fields');

      expect(result.initialMessages).toEqual(initial);
      expect(result.seedMessages).toEqual(seeds);
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

    it('surfaces seedMessages when present in project meta', async () => {
      const seeds = [
        { role: 'user', content: 'Anchor the persona' },
        { role: 'assistant', content: 'Anchored.' },
      ];
      await createTemplateWithZip('get-with-seeds', {
        id: 'get-with-seeds',
        name: 'Get With Seeds',
        description: 'test',
        seedMessages: seeds,
      });
      const { id } = await createProject('get-with-seeds');

      const result = await getProject(id);

      expect(result.seedMessages).toEqual(seeds);
    });

    it('omits seedMessages when not present in project meta', async () => {
      const { id } = await createBlankProject();

      const result = await getProject(id);

      expect(result.seedMessages).toBeUndefined();
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

  describe('template-flow naming', () => {
    it('uses template display name for the first instance and numbers subsequent ones', async () => {
      await createTemplateWithZip('data-curator', {
        id: 'data-curator',
        name: 'Data Curator',
        description: 'test',
      });

      const a = await createProject('data-curator');
      const b = await createProject('data-curator');
      const c = await createProject('data-curator');

      expect(a.name).toBe('Data Curator');
      expect(b.name).toBe('Data Curator 2');
      expect(c.name).toBe('Data Curator 3');
    });

    it('falls back to templateId when template.json has no name', async () => {
      await createTemplateWithZip('no-name-template', {
        id: 'no-name-template',
        description: 'test',
      });

      const result = await createProject('no-name-template');

      expect(result.name).toBe('no-name-template');
    });
  });

  describe('renameProject validation', () => {
    it('throws on empty string', async () => {
      const { id } = await createBlankProject();
      await expect(renameProject(id, '')).rejects.toThrow(/empty/i);
    });

    it('throws on whitespace-only string', async () => {
      const { id } = await createBlankProject();
      await expect(renameProject(id, '   ')).rejects.toThrow(/empty/i);
    });

    it('throws on names longer than 80 characters', async () => {
      const { id } = await createBlankProject();
      const longName = 'a'.repeat(81);
      await expect(renameProject(id, longName)).rejects.toThrow(/80/);
    });

    it('accepts a name of exactly 80 characters', async () => {
      const { id } = await createBlankProject();
      const name = 'a'.repeat(80);
      const result = await renameProject(id, name);
      expect(result.name).toBe(name);
    });

    it('trims leading and trailing whitespace before persisting', async () => {
      const { id } = await createBlankProject();
      const result = await renameProject(id, '  Padded Name  ');
      expect(result.name).toBe('Padded Name');
    });
  });
});
