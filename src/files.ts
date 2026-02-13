import fs from 'node:fs/promises';
import path from 'node:path';
import { getProjectPath } from './config.js';

export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: TreeNode[];
}

/**
 * Resolve a query path to an absolute path within the project.
 * Rejects paths that escape the project root (path traversal).
 */
export function resolveProjectPath(queryPath: string): { absolute: string; relative: string } {
  const projectPath = path.resolve(getProjectPath());
  const absolute = path.resolve(projectPath, path.normalize(queryPath));
  const relative = path.relative(projectPath, absolute);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes project root: ${queryPath}`);
  }

  return { absolute, relative };
}

/**
 * Build a directory tree for the file explorer. Root is the project path.
 */
export async function buildTree(rootPath?: string): Promise<TreeNode> {
  const projectPath = getProjectPath();
  const basePath = rootPath ?? projectPath;
  const name = path.basename(basePath) || 'project';
  const relativePath = path.relative(projectPath, basePath) || '.';

  const stat = await fs.stat(basePath);
  if (!stat.isDirectory()) {
    return { name, path: relativePath, type: 'file' };
  }

  const entries = await fs.readdir(basePath, { withFileTypes: true });
  const children: TreeNode[] = [];

  for (const entry of entries) {
    const fullPath = path.join(basePath, entry.name);
    const childRelative = path.relative(projectPath, fullPath);

    if (entry.isDirectory()) {
      children.push(await buildTree(fullPath));
    } else {
      children.push({ name: entry.name, path: childRelative, type: 'file' });
    }
  }

  children.sort((a, b) => {
    const dirCompare = (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1);
    if (dirCompare !== 0) return dirCompare;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return { name, path: relativePath, type: 'directory', children };
}

/**
 * Read file contents. Throws if not a file or doesn't exist.
 */
export async function readFile(queryPath: string): Promise<string> {
  const { absolute } = resolveProjectPath(queryPath);
  try {
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${queryPath}`);
    }
    return fs.readFile(absolute, 'utf-8');
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr?.code === 'ENOENT') {
      throw new Error(`No file exists at path '${queryPath}'`);
    }
    throw err;
  }
}

/**
 * Write file contents. Auto-creates parent directories.
 */
export async function writeFile(queryPath: string, content: string): Promise<void> {
  const { absolute } = resolveProjectPath(queryPath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, 'utf-8');
}

/**
 * Delete a file. Throws if not a file or doesn't exist.
 */
export async function deleteFile(queryPath: string): Promise<void> {
  const { absolute } = resolveProjectPath(queryPath);
  try {
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${queryPath}`);
    }
    await fs.unlink(absolute);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr?.code === 'ENOENT') {
      throw new Error(`No file exists at path '${queryPath}'`);
    }
    throw err;
  }
}
