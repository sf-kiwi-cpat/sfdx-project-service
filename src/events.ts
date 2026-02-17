import chokidar, { FSWatcher } from 'chokidar';
import path from 'node:path';
import { getProjectPath } from './config.js';

export type FsEventType = 'add' | 'change' | 'unlink';

export interface FsEvent {
  type: FsEventType;
  path: string;
}

/**
 * Create a chokidar watcher for the SFDX project directory.
 * Emits events with paths relative to the project root.
 */
export function createProjectWatcher(onEvent: (event: FsEvent) => void): FSWatcher {
  const projectPath = getProjectPath();

  const watcher = chokidar.watch(projectPath, {
    ignoreInitial: true,
    ignored: (filePath: string) => {
      const normalized = filePath.replace(/\\/g, '/');
      return (
        normalized.includes('/node_modules/') ||
        normalized.includes('/.git/') ||
        normalized.includes('/.sf/') ||
        normalized.endsWith('/node_modules') ||
        normalized.endsWith('/.git') ||
        normalized.endsWith('/.sf') ||
        /\/\.[^/]+(\/|$)/.test(normalized) // dotfile or dotfile directory
      );
    },
  });

  const toRelative = (absPath: string): string =>
    path.relative(projectPath, absPath).replace(/\\/g, '/');

  watcher.on('add', (absPath) => {
    onEvent({ type: 'add', path: toRelative(absPath) });
  });

  watcher.on('change', (absPath) => {
    onEvent({ type: 'change', path: toRelative(absPath) });
  });

  watcher.on('unlink', (absPath) => {
    onEvent({ type: 'unlink', path: toRelative(absPath) });
  });

  return watcher;
}
