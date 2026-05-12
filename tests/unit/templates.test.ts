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

import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_SRC = path.resolve(__dirname, '../../templates/src');
const TEMPLATE_IDS = ['data-curator', 'local-react-test'];

describe('templates on disk', () => {
  it('every template ships an App.uibundle-meta.xml with the canonical lowercase suffix', async () => {
    for (const id of TEMPLATE_IDS) {
      const dir = path.join(TEMPLATES_SRC, id, 'content/force-app/main/default/uiBundles/App');
      const entries = await fs.readdir(dir);
      expect(entries).toContain('App.uibundle-meta.xml');
      // Belt and suspenders: make sure the old mixed-case form is gone so
      // case-sensitive filesystems (Linux, SDR's remote packaging) don't
      // silently miss it.
      expect(entries).not.toContain('App.uiBundle-meta.xml');
    }
  });

  it('every template pins sourceApiVersion >= 66.0 (UIBundle requirement)', async () => {
    for (const id of TEMPLATE_IDS) {
      const raw = await fs.readFile(
        path.join(TEMPLATES_SRC, id, 'content/sfdx-project.json'),
        'utf-8'
      );
      const cfg = JSON.parse(raw) as { sourceApiVersion?: string };
      expect(cfg.sourceApiVersion).toBeDefined();
      const apiVersion = parseFloat(cfg.sourceApiVersion as string);
      expect(apiVersion).toBeGreaterThanOrEqual(66.0);
    }
  });

  describe('data-curator', () => {
    const dir = path.join(TEMPLATES_SRC, 'data-curator/content');

    it('declares 4 deploy stages with authoring-bundle + prompts optional', async () => {
      const raw = await fs.readFile(path.join(dir, 'template.json'), 'utf-8');
      const parsed = JSON.parse(raw) as {
        deployStages?: Array<{ manifest: string; optional?: boolean }>;
      };
      expect(parsed.deployStages).toBeDefined();
      expect(parsed.deployStages).toHaveLength(4);

      const [pkg, flows, bundle, prompts] = parsed.deployStages!;
      expect(pkg.manifest).toBe('manifest/package.xml');
      expect(pkg.optional).toBeFalsy();
      expect(flows.manifest).toBe('manifest/flows-package.xml');
      expect(flows.optional).toBeFalsy();
      expect(bundle.manifest).toBe('manifest/authoring-bundle-package.xml');
      expect(bundle.optional).toBe(true);
      expect(prompts.manifest).toBe('manifest/prompts-package.xml');
      expect(prompts.optional).toBe(true);
    });

    it('every declared manifest exists on disk', async () => {
      const raw = await fs.readFile(path.join(dir, 'template.json'), 'utf-8');
      const parsed = JSON.parse(raw) as {
        deployStages?: Array<{ manifest: string }>;
      };
      for (const stage of parsed.deployStages!) {
        const manifestPath = path.join(dir, stage.manifest);
        await expect(fs.stat(manifestPath)).resolves.toBeDefined();
      }
    });

    it('all manifests pin API version >= 66.0', async () => {
      const manifestDir = path.join(dir, 'manifest');
      const files = await fs.readdir(manifestDir);
      for (const file of files.filter((f) => f.endsWith('.xml'))) {
        const xml = await fs.readFile(path.join(manifestDir, file), 'utf-8');
        const match = xml.match(/<version>([\d.]+)<\/version>/);
        expect(match, `${file} must declare <version>`).toBeTruthy();
        const apiVersion = parseFloat(match![1]);
        expect(apiVersion).toBeGreaterThanOrEqual(66.0);
      }
    });
  });
});
