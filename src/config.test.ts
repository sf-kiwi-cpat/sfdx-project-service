import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { getProjectPath, getDefaultPackagePath } from './config.js';

describe('config', () => {
  let originalProjectRoot: string | undefined;

  beforeEach(() => {
    originalProjectRoot = process.env.PROJECT_ROOT;
  });

  afterEach(() => {
    if (originalProjectRoot === undefined) {
      delete process.env.PROJECT_ROOT;
    } else {
      process.env.PROJECT_ROOT = originalProjectRoot;
    }
  });

  describe('getProjectPath', () => {
    it('returns PROJECT_ROOT when set', () => {
      process.env.PROJECT_ROOT = '/custom/root';
      expect(getProjectPath()).toBe('/custom/root');
    });

    it('falls back to process.cwd() when PROJECT_ROOT is unset', () => {
      delete process.env.PROJECT_ROOT;
      expect(getProjectPath()).toBe(process.cwd());
    });
  });

  describe('getDefaultPackagePath', () => {
    it('returns correct joined path', () => {
      process.env.PROJECT_ROOT = '/my/project';
      expect(getDefaultPackagePath()).toBe(
        path.join('/my/project', 'force-app', 'main', 'default')
      );
    });
  });
});
