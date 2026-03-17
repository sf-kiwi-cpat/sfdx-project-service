import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildTree, readFile, writeFile, deleteFile, resolveProjectPath } from '../../src/domain/files.js';

describe('files', () => {
  let tmpDir: string;
  let originalProjectRoot: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-project-'));
    originalProjectRoot = process.env.PROJECT_ROOT;
    process.env.PROJECT_ROOT = tmpDir;
    // Config is read at call time, so this takes effect for all file operations
  });

  afterEach(async () => {
    process.env.PROJECT_ROOT = originalProjectRoot;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('resolveProjectPath', () => {
    it('resolves relative path within project', () => {
      const { absolute, relative } = resolveProjectPath('force-app/main/default/classes/Foo.cls');
      expect(absolute).toContain(tmpDir);
      expect(relative).toBe('force-app/main/default/classes/Foo.cls');
    });

    it('rejects path traversal', () => {
      expect(() => resolveProjectPath('../../../etc/passwd')).toThrow('Path escapes project root');
    });

    it('rejects restricted paths (.sf, .git, node_modules, dotfiles)', () => {
      expect(() => resolveProjectPath('.sf/auth.json')).toThrow(
        'Access to this path is restricted'
      );
      expect(() => resolveProjectPath('.git/config')).toThrow('Access to this path is restricted');
      expect(() => resolveProjectPath('node_modules/pkg/index.js')).toThrow(
        'Access to this path is restricted'
      );
      expect(() => resolveProjectPath('.env')).toThrow('Access to this path is restricted');
    });

    it('rejects nested restricted paths at any depth', () => {
      expect(() => resolveProjectPath('force-app/.git/config')).toThrow(
        'Access to this path is restricted'
      );
      expect(() => resolveProjectPath('force-app/node_modules/pkg/index.js')).toThrow(
        'Access to this path is restricted'
      );
      expect(() => resolveProjectPath('force-app/.sf/evil.json')).toThrow(
        'Access to this path is restricted'
      );
      expect(() => resolveProjectPath('force-app/main/.eslintrc')).toThrow(
        'Access to this path is restricted'
      );
    });

    it('rejects paths longer than MAX_PATH_LENGTH', () => {
      const longPath = 'a/'.repeat(600) + 'file.cls';
      expect(longPath.length).toBeGreaterThan(1024);
      expect(() => resolveProjectPath(longPath)).toThrow('exceeds maximum allowed length');
    });

    it('rejects path of exactly MAX_PATH_LENGTH characters', () => {
      const exactPath = 'a'.repeat(1024);
      expect(exactPath.length).toBe(1024);
      expect(() => resolveProjectPath(exactPath)).toThrow('exceeds maximum allowed length');
    });
  });

  describe('buildTree', () => {
    it('returns tree structure for empty directory', async () => {
      const tree = await buildTree();
      expect(tree.name).toBeDefined();
      expect(tree.type).toBe('directory');
      expect(tree.children).toEqual([]);
    });

    it('returns tree with files and directories', async () => {
      await fs.mkdir(path.join(tmpDir, 'force-app', 'main', 'default'), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, 'force-app', 'main', 'default', 'Foo.cls'),
        'class Foo {}'
      );
      await fs.writeFile(path.join(tmpDir, 'sfdx-project.json'), '{}');

      const tree = await buildTree();
      expect(tree.children).toBeDefined();
      const names = tree.children!.map((c) => c.name);
      expect(names).toContain('force-app');
      expect(names).toContain('sfdx-project.json');
    });

    it('returns file node when root path is a file', async () => {
      const filePath = path.join(tmpDir, 'sfdx-project.json');
      await fs.writeFile(filePath, '{}');

      const tree = await buildTree(filePath);
      expect(tree.type).toBe('file');
      expect(tree.name).toBe('sfdx-project.json');
      expect(tree.children).toBeUndefined();
    });
  });

  describe('readFile', () => {
    it('reads file contents', async () => {
      const filePath = 'force-app/main/default/classes/Foo.cls';
      await fs.mkdir(path.join(tmpDir, 'force-app', 'main', 'default', 'classes'), {
        recursive: true,
      });
      await fs.writeFile(path.join(tmpDir, filePath), 'class Foo {}');

      const content = await readFile(filePath);
      expect(content).toBe('class Foo {}');
    });

    it('throws FileNotFoundError when file does not exist', async () => {
      await expect(readFile('nonexistent.cls')).rejects.toThrow('No file exists at path');
    });

    it('throws NotAFileError when path is a directory', async () => {
      await fs.mkdir(path.join(tmpDir, 'force-app', 'main'), { recursive: true });
      await expect(readFile('force-app/main')).rejects.toThrow('Not a file');
    });
  });

  describe('writeFile', () => {
    it('creates file with content', async () => {
      const filePath = 'force-app/main/default/classes/Foo.cls';
      await writeFile(filePath, 'class Foo {}');

      const content = await fs.readFile(path.join(tmpDir, filePath), 'utf-8');
      expect(content).toBe('class Foo {}');
    });

    it('auto-creates parent directories', async () => {
      const filePath = 'force-app/main/default/classes/Bar.cls';
      await writeFile(filePath, 'class Bar {}');

      const stat = await fs.stat(path.join(tmpDir, filePath));
      expect(stat.isFile()).toBe(true);
    });
  });

  describe('deleteFile', () => {
    it('deletes existing file', async () => {
      const filePath = 'force-app/main/default/classes/Foo.cls';
      await fs.mkdir(path.join(tmpDir, 'force-app', 'main', 'default', 'classes'), {
        recursive: true,
      });
      await fs.writeFile(path.join(tmpDir, filePath), 'class Foo {}');

      await deleteFile(filePath);

      await expect(fs.access(path.join(tmpDir, filePath))).rejects.toThrow();
    });

    it('throws FileNotFoundError when file does not exist', async () => {
      await expect(deleteFile('nonexistent.cls')).rejects.toThrow('No file exists at path');
    });

    it('throws NotAFileError when path is a directory', async () => {
      await fs.mkdir(path.join(tmpDir, 'force-app', 'main'), { recursive: true });
      await expect(deleteFile('force-app/main')).rejects.toThrow('Not a file');
    });
  });
});
