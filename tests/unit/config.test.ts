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
import path from 'node:path';
import { getProjectPath, getProjectsRoot, getTemplatesDir } from '../../src/config.js';

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
