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
  injectBootstrap,
  resolveDistPlaceholders,
  resolvePluginAssetPath,
  readPluginIndexHtml,
  getPlatformCssPath,
  ProjectVisualizationEngine,
  PluginNotFoundError,
  UnsupportedFileTypeError,
} from '../../src/domain/visualize.js';
import { FileNotFoundError, NotAFileError, PathTraversalError } from '../../src/errors.js';

describe('resolveDistPlaceholders', () => {
  it('rewrites @dist/ to the project-scoped platform route', () => {
    const html = '<link href="@dist/design-system/platform.css">';
    const out = resolveDistPlaceholders(html, 'proj-123');
    expect(out).toBe(
      '<link href="/v1/projects/proj-123/visualize/platform/design-system/platform.css">'
    );
  });

  it('rewrites every occurrence', () => {
    const html = '<a>@dist/a.js</a><b>@dist/b.css</b>';
    const out = resolveDistPlaceholders(html, 'p');
    expect(out).not.toContain('@dist/');
    expect(out.match(/\/v1\/projects\/p\/visualize\/platform\//g)).toHaveLength(2);
  });

  it('is a no-op when the placeholder is absent', () => {
    const html = '<html><body>nothing here</body></html>';
    expect(resolveDistPlaceholders(html, 'p')).toBe(html);
  });
});

describe('injectBootstrap', () => {
  it('injects the script before </head> when present', () => {
    const html = '<html><head><title>x</title></head><body></body></html>';
    const out = injectBootstrap(html);
    expect(out).toContain('__ExtensionHostPostMessage');
    expect(out.indexOf('__ExtensionHostPostMessage')).toBeLessThan(out.indexOf('</head>'));
  });

  it('falls back to before </body> when there is no </head>', () => {
    const html = '<html><body><div></div></body></html>';
    const out = injectBootstrap(html);
    expect(out).toContain('__ExtensionHostPostMessage');
    expect(out.indexOf('__ExtensionHostPostMessage')).toBeLessThan(out.indexOf('</body>'));
  });

  it('prepends the script when neither tag is present', () => {
    const html = '<div>raw</div>';
    const out = injectBootstrap(html);
    expect(out.startsWith('<script>')).toBe(true);
    expect(out).toContain('<div>raw</div>');
  });

  it('emits a script that posts to window.parent', () => {
    const out = injectBootstrap('<html><head></head></html>');
    expect(out).toContain('window.parent.postMessage');
  });
});

describe('resolvePluginAssetPath', () => {
  // Build a fake engine that pretends a plugin exists. We don't need the real
  // framework here — only the shape `resolvePluginAssetPath` consumes.
  const fakeEngine = {
    hasPlugin: (id: string) => id === 'schema',
  } as unknown as ProjectVisualizationEngine;

  it('throws PluginNotFoundError for an unknown plugin', () => {
    expect(() => resolvePluginAssetPath(fakeEngine, 'nope', 'foo.js')).toThrow(PluginNotFoundError);
  });

  it('rejects a path that escapes the assets dir', () => {
    expect(() => resolvePluginAssetPath(fakeEngine, 'schema', '../../etc/passwd')).toThrow(
      FileNotFoundError
    );
  });

  it('decodes percent-escaped traversal attempts and rejects them', () => {
    const escaped = decodeURIComponent('..%2F..%2Fetc%2Fpasswd');
    // sanity: this is the same string the route will decode before calling us
    expect(escaped).toBe('../../etc/passwd');
    expect(() => resolvePluginAssetPath(fakeEngine, 'schema', '..%2F..%2Fetc%2Fpasswd')).toThrow(
      FileNotFoundError
    );
  });

  it('returns an absolute path under the plugin assets dir for an in-tree asset', () => {
    const out = resolvePluginAssetPath(fakeEngine, 'schema', 'index-abc.js');
    expect(path.isAbsolute(out)).toBe(true);
    expect(out).toMatch(/[\\/]plugins[\\/]schema[\\/]ui[\\/]assets[\\/]index-abc\.js$/);
  });
});

describe('getPlatformCssPath', () => {
  it('points at a real, readable file on disk', async () => {
    const p = getPlatformCssPath();
    expect(path.isAbsolute(p)).toBe(true);
    const stat = await fs.stat(p);
    expect(stat.isFile()).toBe(true);
  });
});

describe('ProjectVisualizationEngine', () => {
  let projectDir: string;
  let engine: ProjectVisualizationEngine;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viz-engine-test-'));
    // Seed an `objects/` directory but no .object-meta.xml files yet, so
    // listHandledFiles starts empty and we can append fixtures per-test.
    await fs.mkdir(path.join(projectDir, 'force-app', 'main', 'default', 'objects'), {
      recursive: true,
    });
    engine = await ProjectVisualizationEngine.create(projectDir);
  });

  afterEach(async () => {
    engine.dispose();
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  describe('listPlugins', () => {
    it('exposes both shipped plugins (schema and flexipage)', () => {
      const plugins = engine.listPlugins();
      const ids = plugins.map((p) => p.id).sort();
      expect(ids).toEqual(['flexipage', 'schema']);
    });

    it('includes filePatterns the schema plugin handles', () => {
      const schema = engine.listPlugins().find((p) => p.id === 'schema');
      expect(schema?.filePatterns).toContain('.object-meta.xml');
    });
  });

  describe('hasPlugin', () => {
    it('returns true for a shipped plugin', () => {
      expect(engine.hasPlugin('schema')).toBe(true);
    });

    it('returns false for an unknown id', () => {
      expect(engine.hasPlugin('does-not-exist')).toBe(false);
    });
  });

  describe('listHandledFiles', () => {
    it('returns an empty list when no metadata files exist', async () => {
      expect(await engine.listHandledFiles(projectDir)).toEqual([]);
    });

    it('finds .object-meta.xml files and tags them with the schema plugin', async () => {
      const objDir = path.join(projectDir, 'force-app', 'main', 'default', 'objects', 'X__c');
      await fs.mkdir(objDir, { recursive: true });
      await fs.writeFile(path.join(objDir, 'X__c.object-meta.xml'), '<x/>');

      const files = await engine.listHandledFiles(projectDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({
        path: 'force-app/main/default/objects/X__c/X__c.object-meta.xml',
        fileName: 'X__c.object-meta.xml',
        pluginId: 'schema',
      });
    });

    it('uses forward slashes in the returned path', async () => {
      const objDir = path.join(projectDir, 'force-app', 'main', 'default', 'objects', 'Y__c');
      await fs.mkdir(objDir, { recursive: true });
      await fs.writeFile(path.join(objDir, 'Y__c.object-meta.xml'), '<x/>');
      const files = await engine.listHandledFiles(projectDir);
      expect(files[0].path).not.toContain('\\');
    });
  });

  describe('visualizeFile', () => {
    it('throws PathTraversalError for a path that escapes the project root', async () => {
      await expect(engine.visualizeFile(projectDir, '../../etc/passwd')).rejects.toThrow(
        PathTraversalError
      );
    });

    it('throws FileNotFoundError when the path resolves to a missing file', async () => {
      await expect(
        engine.visualizeFile(
          projectDir,
          'force-app/main/default/objects/Nope__c/Nope__c.object-meta.xml'
        )
      ).rejects.toThrow(FileNotFoundError);
    });

    it('throws NotAFileError when the path resolves to a directory', async () => {
      const objDir = path.join(projectDir, 'force-app', 'main', 'default', 'objects', 'Dir__c');
      await fs.mkdir(objDir, { recursive: true });
      await expect(
        engine.visualizeFile(projectDir, 'force-app/main/default/objects/Dir__c')
      ).rejects.toThrow(NotAFileError);
    });

    it('throws UnsupportedFileTypeError for a file no plugin handles', async () => {
      await fs.writeFile(path.join(projectDir, 'sfdx-project.json'), '{}');
      await expect(engine.visualizeFile(projectDir, 'sfdx-project.json')).rejects.toThrow(
        UnsupportedFileTypeError
      );
    });
  });
});

describe('readPluginIndexHtml', () => {
  let engine: ProjectVisualizationEngine;
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viz-index-test-'));
    engine = await ProjectVisualizationEngine.create(projectDir);
  });

  afterEach(async () => {
    engine.dispose();
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('throws PluginNotFoundError for an unknown plugin', async () => {
    await expect(readPluginIndexHtml(engine, 'nope', 'pid')).rejects.toThrow(PluginNotFoundError);
  });

  it('serves the schema plugin index.html with both transforms applied', async () => {
    const html = await readPluginIndexHtml(engine, 'schema', 'pid');
    expect(html).toContain('<html');
    expect(html).not.toContain('@dist/');
    expect(html).toContain('/v1/projects/pid/visualize/platform/');
    expect(html).toContain('__ExtensionHostPostMessage');
  });
});
