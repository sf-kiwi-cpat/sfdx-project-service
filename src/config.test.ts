import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { getProjectPath, getProjectsRoot, getTemplatesDir } from './config.js';

describe('config', () => {
  let originalProjectRoot: string | undefined;
  let originalProjectsRoot: string | undefined;
  let originalTemplatesDir: string | undefined;

  beforeEach(() => {
    originalProjectRoot = process.env.PROJECT_ROOT;
    originalProjectsRoot = process.env.PROJECTS_ROOT;
    originalTemplatesDir = process.env.TEMPLATES_DIR;
  });

  afterEach(() => {
    if (originalProjectRoot === undefined) {
      delete process.env.PROJECT_ROOT;
    } else {
      process.env.PROJECT_ROOT = originalProjectRoot;
    }
    if (originalProjectsRoot === undefined) {
      delete process.env.PROJECTS_ROOT;
    } else {
      process.env.PROJECTS_ROOT = originalProjectsRoot;
    }
    if (originalTemplatesDir === undefined) {
      delete process.env.TEMPLATES_DIR;
    } else {
      process.env.TEMPLATES_DIR = originalTemplatesDir;
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

  describe('getProjectsRoot', () => {
    it('returns PROJECTS_ROOT when set', () => {
      process.env.PROJECTS_ROOT = '/custom/projects';
      expect(getProjectsRoot()).toBe('/custom/projects');
    });

    it('falls back to {cwd}/projects when PROJECTS_ROOT is unset', () => {
      delete process.env.PROJECTS_ROOT;
      expect(getProjectsRoot()).toBe(path.resolve(process.cwd(), 'projects'));
    });
  });

  describe('getTemplatesDir', () => {
    it('returns TEMPLATES_DIR when set', () => {
      process.env.TEMPLATES_DIR = '/custom/templates';
      expect(getTemplatesDir()).toBe('/custom/templates');
    });

    it('falls back to ../templates relative to module dir when TEMPLATES_DIR is unset', () => {
      delete process.env.TEMPLATES_DIR;
      const result = getTemplatesDir();
      expect(result).toContain('templates');
      expect(path.isAbsolute(result)).toBe(true);
    });
  });
});
