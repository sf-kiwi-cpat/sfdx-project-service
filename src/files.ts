import fs from 'node:fs/promises';
import path from 'node:path';
import { getProjectPath } from './config.js';
import {
  FileNotFoundError,
  MAX_PATH_LENGTH,
  NotAFileError,
  PathTooLongError,
  PathTraversalError,
  RestrictedPathError,
} from './errors.js';

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
export function resolveProjectPath(
  queryPath: string,
  projectRoot?: string
): { absolute: string; relative: string } {
  // Defense-in-depth guard: reject clearly oversized input (UTF-16 code units) before
  // reaching any fs call. MAX_PATH_LENGTH is intentionally conservative relative to
  // PATH_MAX (4096 bytes) because the absolute path includes the project root prefix.
  // The ENAMETOOLONG handler in errorToProblem() is a safety net for cases this guard
  // doesn't catch (e.g., short queryPath + long project root, or NAME_MAX per-segment limit).
  if (queryPath.length >= MAX_PATH_LENGTH) {
    throw new PathTooLongError(queryPath.length);
  }
  const projectPath = projectRoot ?? path.resolve(getProjectPath());
  const absolute = path.resolve(projectPath, path.normalize(queryPath));
  const relative = path.relative(projectPath, absolute);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new PathTraversalError(queryPath);
  }

  if (isRestrictedPath(relative)) {
    throw new RestrictedPathError();
  }

  return { absolute, relative };
}

/** Paths to exclude from the tree and block from file operations. */
const IGNORED_NAMES = new Set(['node_modules', '.git', '.sf']);

function shouldIgnoreEntry(entryName: string): boolean {
  return IGNORED_NAMES.has(entryName) || entryName.startsWith('.');
}

/** Reject paths that resolve into .sf/, .git/, node_modules/, or dotfiles at any level. */
function isRestrictedPath(relative: string): boolean {
  const segments = relative.split(/[/\\]/).filter(Boolean);
  return segments.some((seg) => shouldIgnoreEntry(seg));
}

/**
 * Build a directory tree for the file explorer. Root is the project path.
 * Excludes .git, .sf, node_modules, and dotfiles (matches watcher ignores).
 */
export async function buildTree(rootPath?: string, projectRoot?: string): Promise<TreeNode> {
  const baseProjectPath = projectRoot ?? getProjectPath();
  const basePath = rootPath ?? baseProjectPath;
  const name = path.basename(basePath) || 'project';
  const relativePath = path.relative(baseProjectPath, basePath) || '.';

  const stat = await fs.stat(basePath);
  if (!stat.isDirectory()) {
    return { name, path: relativePath, type: 'file' };
  }

  const entries = await fs.readdir(basePath, { withFileTypes: true });
  const children: TreeNode[] = [];

  for (const entry of entries) {
    if (shouldIgnoreEntry(entry.name)) continue;

    const fullPath = path.join(basePath, entry.name);
    const childRelative = path.relative(baseProjectPath, fullPath);

    if (entry.isDirectory()) {
      children.push(await buildTree(fullPath, baseProjectPath));
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
export async function readFile(queryPath: string, projectRoot?: string): Promise<string> {
  const { absolute } = resolveProjectPath(queryPath, projectRoot);
  try {
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) {
      throw new NotAFileError(queryPath);
    }
    return fs.readFile(absolute, 'utf-8');
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr?.code === 'ENOENT') {
      throw new FileNotFoundError(queryPath);
    }
    throw err;
  }
}

/**
 * Write file contents. Auto-creates parent directories.
 */
export async function writeFile(
  queryPath: string,
  content: string,
  projectRoot?: string
): Promise<void> {
  const { absolute } = resolveProjectPath(queryPath, projectRoot);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, 'utf-8');
}

/**
 * Delete a file. Throws if not a file or doesn't exist.
 */
export async function deleteFile(queryPath: string, projectRoot?: string): Promise<void> {
  const { absolute } = resolveProjectPath(queryPath, projectRoot);
  try {
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) {
      throw new NotAFileError(queryPath);
    }
    await fs.unlink(absolute);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr?.code === 'ENOENT') {
      throw new FileNotFoundError(queryPath);
    }
    throw err;
  }
}
