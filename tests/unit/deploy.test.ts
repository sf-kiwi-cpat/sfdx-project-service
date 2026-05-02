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

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  buildComponentSet,
  mapStatusToProgressEvent,
  readDeployStages,
} from '../../src/domain/deploy.js';
import { BuildError } from '../../src/errors.js';

describe('buildComponentSet', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws when packageDirectories is empty', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-deploy-'));
    await fs.writeFile(
      path.join(tmpDir, 'sfdx-project.json'),
      JSON.stringify({ packageDirectories: [] })
    );

    await expect(buildComponentSet(tmpDir)).rejects.toThrow(
      'sfdx-project.json must contain at least one packageDirectory'
    );
  });

  it('throws when packageDirectories is missing', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-deploy-'));
    await fs.writeFile(path.join(tmpDir, 'sfdx-project.json'), JSON.stringify({}));

    await expect(buildComponentSet(tmpDir)).rejects.toThrow(
      'sfdx-project.json must contain at least one packageDirectory'
    );
  });
});

describe('mapStatusToProgressEvent', () => {
  it('maps a full status update with file responses', () => {
    const statusUpdate = {
      status: 'InProgress',
      numberComponentsDeployed: 2,
      numberComponentsTotal: 5,
      getFileResponses: () => [
        { fullName: 'MyObject__c', type: 'CustomObject', state: 'Created' },
        { fullName: 'MyField__c', type: 'CustomField', state: 'Changed' },
      ],
    };

    const event = mapStatusToProgressEvent('dep-1', statusUpdate);

    expect(event.deploymentId).toBe('dep-1');
    expect(event.status).toBe('InProgress');
    expect(event.numberComponentsDeployed).toBe(2);
    expect(event.numberComponentsTotal).toBe(5);
    expect(event.components).toEqual([
      { fullName: 'MyObject__c', type: 'CustomObject', state: 'Created' },
      { fullName: 'MyField__c', type: 'CustomField', state: 'Changed' },
    ]);
    expect(event.timestamp).toBeDefined();
  });

  it('defaults to InProgress when status is missing', () => {
    const event = mapStatusToProgressEvent('dep-2', {});

    expect(event.status).toBe('InProgress');
    expect(event.numberComponentsDeployed).toBe(0);
    expect(event.numberComponentsTotal).toBe(0);
    expect(event.components).toEqual([]);
  });

  it('handles missing getFileResponses gracefully', () => {
    const event = mapStatusToProgressEvent('dep-3', {
      status: 'Succeeded',
      numberComponentsDeployed: 3,
      numberComponentsTotal: 3,
    });

    expect(event.status).toBe('Succeeded');
    expect(event.components).toEqual([]);
  });
});

describe('readDeployStages', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  async function writeTemplate(content: string): Promise<void> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-stages-'));
    await fs.writeFile(path.join(tmpDir, 'template.json'), content);
  }

  it('returns undefined when template.json is absent', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-stages-'));
    expect(await readDeployStages(tmpDir)).toBeUndefined();
  });

  it('returns undefined when template.json has no deployStages key', async () => {
    await writeTemplate(JSON.stringify({ id: 'x', name: 'X' }));
    expect(await readDeployStages(tmpDir)).toBeUndefined();
  });

  it('returns undefined when deployStages is an empty array', async () => {
    await writeTemplate(JSON.stringify({ deployStages: [] }));
    expect(await readDeployStages(tmpDir)).toBeUndefined();
  });

  it('parses valid deployStages', async () => {
    await writeTemplate(
      JSON.stringify({
        deployStages: [
          { manifest: 'manifest/package.xml' },
          { manifest: 'manifest/prompts.xml', optional: true },
        ],
      })
    );
    const stages = await readDeployStages(tmpDir);
    expect(stages).toEqual([
      { manifest: 'manifest/package.xml' },
      { manifest: 'manifest/prompts.xml', optional: true },
    ]);
  });

  it('throws BuildError on invalid JSON', async () => {
    await writeTemplate('{ not: valid json');
    await expect(readDeployStages(tmpDir)).rejects.toThrow(BuildError);
    await expect(readDeployStages(tmpDir)).rejects.toThrow('Invalid template.json');
  });

  it('throws BuildError when deployStages is not an array', async () => {
    await writeTemplate(JSON.stringify({ deployStages: 'nope' }));
    await expect(readDeployStages(tmpDir)).rejects.toThrow('must be an array');
  });

  it('throws BuildError when a stage is not an object', async () => {
    await writeTemplate(JSON.stringify({ deployStages: ['manifest/package.xml'] }));
    await expect(readDeployStages(tmpDir)).rejects.toThrow('must be an object');
  });

  it('throws BuildError when a stage.manifest is missing', async () => {
    await writeTemplate(JSON.stringify({ deployStages: [{ optional: true }] }));
    await expect(readDeployStages(tmpDir)).rejects.toThrow('must be a non-empty string');
  });

  it('throws BuildError when a stage.manifest is empty', async () => {
    await writeTemplate(JSON.stringify({ deployStages: [{ manifest: '' }] }));
    await expect(readDeployStages(tmpDir)).rejects.toThrow('must be a non-empty string');
  });

  it('blocks manifest paths that escape the project root', async () => {
    await writeTemplate(JSON.stringify({ deployStages: [{ manifest: '../../etc/passwd' }] }));
    await expect(readDeployStages(tmpDir)).rejects.toThrow('escapes project root');
  });

  it('blocks absolute manifest paths that escape the project root', async () => {
    await writeTemplate(JSON.stringify({ deployStages: [{ manifest: '/etc/passwd' }] }));
    await expect(readDeployStages(tmpDir)).rejects.toThrow('escapes project root');
  });

  it('accepts paths that resolve inside the project root', async () => {
    await writeTemplate(
      JSON.stringify({
        deployStages: [{ manifest: 'sub/./../manifest/package.xml' }],
      })
    );
    const stages = await readDeployStages(tmpDir);
    expect(stages).toEqual([{ manifest: 'sub/./../manifest/package.xml' }]);
  });
});
