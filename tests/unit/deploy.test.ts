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

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  assignDeployedPermissionSets,
  buildComponentSet,
  mapStatusToProgressEvent,
  publishDeployedAiAuthoringBundles,
  readDeployStages,
  toAppDomainUrl,
} from '../../src/domain/deploy.js';
import { BuildError } from '../../src/errors.js';
import {
  createDeployment,
  clearAllDeployments,
  getDeploymentWarningEvents,
} from '../../src/deployments.js';
import type { Connection } from '@salesforce/core';

// Mocks for SfProject.resolve and Agent.init — both reach the network/disk
// in production. Each test wires per-call behavior via `mockImplementation`.
const sfProjectResolveMock = vi.fn();
const agentInitMock = vi.fn();

vi.mock('@salesforce/core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    SfProject: { resolve: (...args: unknown[]) => sfProjectResolveMock(...args) },
  };
});

vi.mock('@salesforce/agents', () => ({
  Agent: { init: (...args: unknown[]) => agentInitMock(...args) },
}));

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

describe('toAppDomainUrl', () => {
  it('rewrites a pc-rnd sandbox instance URL to the canonical --c app domain', () => {
    expect(toAppDomainUrl('https://orgfarm-1fa1bb3933.test1.my.pc-rnd.salesforce.com')).toBe(
      'https://orgfarm-1fa1bb3933--c.test1.my.pc-rnd.salesforce.app'
    );
  });

  it('rewrites a prod-shape instance URL', () => {
    expect(toAppDomainUrl('https://acme.my.salesforce.com')).toBe(
      'https://acme--c.my.salesforce.app'
    );
  });

  it('rewrites a scratch org URL', () => {
    expect(toAppDomainUrl('https://acme-dev-ed.scratch.my.salesforce.com')).toBe(
      'https://acme-dev-ed--c.scratch.my.salesforce.app'
    );
  });

  it('preserves a trailing path on the instance URL', () => {
    expect(toAppDomainUrl('https://acme.my.salesforce.com/services/data')).toBe(
      'https://acme--c.my.salesforce.app/services/data'
    );
  });

  it('passes through a URL already on the salesforce.app domain', () => {
    const url = 'https://acme--c.my.salesforce.app';
    expect(toAppDomainUrl(url)).toBe(url);
  });

  it('returns null when the leftmost label already carries a namespace marker', () => {
    expect(toAppDomainUrl('https://acme--ns.my.salesforce.com')).toBeNull();
  });

  it('returns null for non-Salesforce hosts', () => {
    expect(toAppDomainUrl('https://example.com')).toBeNull();
  });

  it('returns null for malformed URLs', () => {
    expect(toAppDomainUrl('not a url')).toBeNull();
    expect(toAppDomainUrl('')).toBeNull();
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

describe('assignDeployedPermissionSets', () => {
  let deploymentId: string;

  beforeEach(() => {
    clearAllDeployments();
    deploymentId = createDeployment('proj-1');
  });

  function makeConnection(opts: {
    userId?: string | null;
    username?: string | null;
    userQueryResult?: Array<{ Id: string }>;
    permsetLookup?: Array<{ Id: string; Name: string }>;
    existingAssignments?: Array<{ PermissionSetId: string }>;
    createImpl?: (record: { AssigneeId: string; PermissionSetId: string }) => {
      success: boolean;
      errors?: Array<{ message?: string }>;
    };
  }): Connection {
    const queryMock = vi.fn().mockImplementation((soql: string) => {
      if (soql.startsWith('SELECT Id FROM User')) {
        return Promise.resolve({ records: opts.userQueryResult ?? [] });
      }
      if (soql.startsWith('SELECT Id, Name FROM PermissionSet')) {
        return Promise.resolve({ records: opts.permsetLookup ?? [] });
      }
      if (soql.startsWith('SELECT PermissionSetId FROM PermissionSetAssignment')) {
        return Promise.resolve({ records: opts.existingAssignments ?? [] });
      }
      return Promise.resolve({ records: [] });
    });
    const createMock = vi
      .fn()
      .mockImplementation((record: { AssigneeId: string; PermissionSetId: string }) =>
        Promise.resolve(opts.createImpl?.(record) ?? { success: true })
      );
    return {
      query: queryMock,
      sobject: vi.fn(() => ({ create: createMock })),
      getAuthInfoFields: () => ({
        userId: 'userId' in opts ? opts.userId : '005xx0000000001',
        username: 'username' in opts ? opts.username : 'deploy@example.com',
      }),
    } as unknown as Connection;
  }

  it('returns no warnings and skips queries when no PermissionSet was deployed', async () => {
    const connection = makeConnection({});
    const warnings = await assignDeployedPermissionSets(
      deploymentId,
      [{ fullName: 'Foo__c', type: 'CustomField', state: 'Created' }],
      connection
    );
    expect(warnings).toEqual([]);
    expect(connection.query).not.toHaveBeenCalled();
  });

  it('assigns a deployed permset that the user does not yet have', async () => {
    const created: unknown[] = [];
    const connection = makeConnection({
      permsetLookup: [{ Id: '0PSx1', Name: 'My_App_Admin' }],
      existingAssignments: [],
      createImpl: (record) => {
        created.push(record);
        return { success: true };
      },
    });
    const warnings = await assignDeployedPermissionSets(
      deploymentId,
      [{ fullName: 'My_App_Admin', type: 'PermissionSet', state: 'Created' }],
      connection
    );
    expect(warnings).toEqual([]);
    expect(created).toEqual([{ AssigneeId: '005xx0000000001', PermissionSetId: '0PSx1' }]);
  });

  it('skips permsets the user already has assigned (idempotent re-deploy)', async () => {
    const sobjectMock = vi.fn(() => ({ create: vi.fn() }));
    const connection = {
      query: vi.fn().mockImplementation((soql: string) => {
        if (soql.startsWith('SELECT Id, Name FROM PermissionSet')) {
          return Promise.resolve({ records: [{ Id: '0PSx1', Name: 'My_App_Admin' }] });
        }
        return Promise.resolve({ records: [{ PermissionSetId: '0PSx1' }] });
      }),
      sobject: sobjectMock,
      getAuthInfoFields: () => ({ userId: '005xx0000000001' }),
    } as unknown as Connection;

    const warnings = await assignDeployedPermissionSets(
      deploymentId,
      [{ fullName: 'My_App_Admin', type: 'PermissionSet', state: 'Changed' }],
      connection
    );
    expect(warnings).toEqual([]);
    expect(sobjectMock).not.toHaveBeenCalled();
  });

  it('warns and skips when the deployed permset cannot be found in the org', async () => {
    const connection = makeConnection({
      permsetLookup: [],
      existingAssignments: [],
    });
    const warnings = await assignDeployedPermissionSets(
      deploymentId,
      [{ fullName: 'Mystery_PS', type: 'PermissionSet', state: 'Created' }],
      connection
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].errorMessage).toMatch(/'Mystery_PS' was reported deployed but not found/);
    expect(getDeploymentWarningEvents(deploymentId)).toEqual(warnings);
  });

  it('warns when PermissionSetAssignment insert fails', async () => {
    const connection = makeConnection({
      permsetLookup: [{ Id: '0PSx1', Name: 'My_App_Admin' }],
      existingAssignments: [],
      createImpl: () => ({ success: false, errors: [{ message: 'INSUFFICIENT_ACCESS' }] }),
    });
    const warnings = await assignDeployedPermissionSets(
      deploymentId,
      [{ fullName: 'My_App_Admin', type: 'PermissionSet', state: 'Created' }],
      connection
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].errorMessage).toMatch(/INSUFFICIENT_ACCESS/);
  });

  it('falls back to a User SOQL lookup when getAuthInfoFields().userId is missing', async () => {
    const created: unknown[] = [];
    const connection = makeConnection({
      userId: null,
      username: 'deploy@example.com',
      userQueryResult: [{ Id: '005FALLBACK0001' }],
      permsetLookup: [{ Id: '0PSx1', Name: 'My_App_Admin' }],
      existingAssignments: [],
      createImpl: (record) => {
        created.push(record);
        return { success: true };
      },
    });
    const warnings = await assignDeployedPermissionSets(
      deploymentId,
      [{ fullName: 'My_App_Admin', type: 'PermissionSet', state: 'Created' }],
      connection
    );
    expect(warnings).toEqual([]);
    expect(created).toEqual([{ AssigneeId: '005FALLBACK0001', PermissionSetId: '0PSx1' }]);
  });

  it('warns and bails when neither userId nor username can resolve to a User', async () => {
    const connection = makeConnection({
      userId: null,
      username: 'deploy@example.com',
      userQueryResult: [],
    });
    const warnings = await assignDeployedPermissionSets(
      deploymentId,
      [{ fullName: 'My_App_Admin', type: 'PermissionSet', state: 'Created' }],
      connection
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].errorMessage).toMatch(/Could not resolve deploying userId/);
  });

  it('warns and bails when neither userId nor username are present', async () => {
    const connection = makeConnection({ userId: null, username: null });
    const warnings = await assignDeployedPermissionSets(
      deploymentId,
      [{ fullName: 'My_App_Admin', type: 'PermissionSet', state: 'Created' }],
      connection
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].errorMessage).toMatch(/Could not resolve deploying userId/);
    expect(connection.query).not.toHaveBeenCalled();
  });

  it('deduplicates duplicate PermissionSet entries before querying', async () => {
    const queryMock = vi.fn().mockImplementation((soql: string) => {
      if (soql.startsWith('SELECT Id, Name FROM PermissionSet')) {
        return Promise.resolve({ records: [{ Id: '0PSx1', Name: 'My_App_Admin' }] });
      }
      return Promise.resolve({ records: [{ PermissionSetId: '0PSx1' }] });
    });
    const connection = {
      query: queryMock,
      sobject: vi.fn(() => ({ create: vi.fn() })),
      getAuthInfoFields: () => ({ userId: '005xx0000000001' }),
    } as unknown as Connection;

    await assignDeployedPermissionSets(
      deploymentId,
      [
        { fullName: 'My_App_Admin', type: 'PermissionSet', state: 'Created' },
        { fullName: 'My_App_Admin', type: 'PermissionSet', state: 'Changed' },
      ],
      connection
    );
    const lookupCall = queryMock.mock.calls.find((c: unknown[]) =>
      (c[0] as string).startsWith('SELECT Id, Name FROM PermissionSet')
    );
    expect(lookupCall?.[0]).toBe(
      "SELECT Id, Name FROM PermissionSet WHERE Name IN ('My_App_Admin')"
    );
  });
});

describe('publishDeployedAiAuthoringBundles', () => {
  let deploymentId: string;
  const projectDir = '/tmp/fake-project';

  beforeEach(() => {
    clearAllDeployments();
    deploymentId = createDeployment('proj-aab');
    sfProjectResolveMock.mockReset();
    agentInitMock.mockReset();
    sfProjectResolveMock.mockResolvedValue({
      stub: 'project',
      getDefaultPackage: () => ({ path: 'force-app', fullPath: '/abs/force-app' }),
    });
  });

  function makePublishingScriptAgent(opts: {
    publish: () => Promise<{ botId: string; botVersionId: string; developerName: string }>;
  }): { publish: ReturnType<typeof vi.fn> } {
    const publishMock = vi.fn().mockImplementation(opts.publish);
    return { publish: publishMock };
  }

  function makeProductionAgent(opts: { activate: () => Promise<{ Id: string; Status: string }> }): {
    activate: ReturnType<typeof vi.fn>;
  } {
    const activateMock = vi.fn().mockImplementation(opts.activate);
    return { activate: activateMock };
  }

  const fakeConnection = {} as unknown as Connection;

  it('returns no warnings and skips Agent.init when no AiAuthoringBundle was deployed', async () => {
    const warnings = await publishDeployedAiAuthoringBundles(
      deploymentId,
      [{ fullName: 'Foo__c', type: 'CustomField', state: 'Created' }],
      fakeConnection,
      projectDir
    );
    expect(warnings).toEqual([]);
    expect(agentInitMock).not.toHaveBeenCalled();
    expect(sfProjectResolveMock).not.toHaveBeenCalled();
    expect(getDeploymentWarningEvents(deploymentId)).toEqual([]);
  });

  it('returns no warnings and skips Agent.init when componentSuccesses is empty', async () => {
    const warnings = await publishDeployedAiAuthoringBundles(
      deploymentId,
      [],
      fakeConnection,
      projectDir
    );
    expect(warnings).toEqual([]);
    expect(agentInitMock).not.toHaveBeenCalled();
  });

  it('publishes and activates a single deployed AiAuthoringBundle', async () => {
    const scriptAgent = makePublishingScriptAgent({
      publish: async () => ({
        botId: '0Xx00000000001',
        botVersionId: '0XV00000000001',
        developerName: 'DataCuratorAgent',
      }),
    });
    const productionAgent = makeProductionAgent({
      activate: async () => ({ Id: '0XV00000000001', Status: 'Active' }),
    });
    agentInitMock.mockResolvedValueOnce(scriptAgent).mockResolvedValueOnce(productionAgent);

    const warnings = await publishDeployedAiAuthoringBundles(
      deploymentId,
      [{ fullName: 'DataCuratorAgent', type: 'AiAuthoringBundle', state: 'Created' }],
      fakeConnection,
      projectDir
    );
    expect(warnings).toEqual([]);
    expect(scriptAgent.publish).toHaveBeenCalledWith(true);
    expect(productionAgent.activate).toHaveBeenCalledTimes(1);
    expect(agentInitMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        connection: fakeConnection,
        aabName: 'DataCuratorAgent',
      })
    );
    expect(agentInitMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        connection: fakeConnection,
        apiNameOrId: '0Xx00000000001',
      })
    );
  });

  it('publishes and activates each AiAuthoringBundle when multiple are deployed', async () => {
    const calls: string[] = [];
    agentInitMock.mockImplementation(async (opts: Record<string, unknown>) => {
      if ('aabName' in opts) {
        const name = opts.aabName as string;
        calls.push(`publish:${name}`);
        return {
          publish: vi.fn().mockResolvedValue({
            botId: `bot_${name}`,
            botVersionId: `ver_${name}`,
            developerName: name,
          }),
        };
      }
      const id = opts.apiNameOrId as string;
      calls.push(`activate:${id}`);
      return {
        activate: vi.fn().mockResolvedValue({ Id: 'ver', Status: 'Active' }),
      };
    });

    const warnings = await publishDeployedAiAuthoringBundles(
      deploymentId,
      [
        { fullName: 'AgentA', type: 'AiAuthoringBundle', state: 'Created' },
        { fullName: 'AgentB', type: 'AiAuthoringBundle', state: 'Created' },
      ],
      fakeConnection,
      projectDir
    );
    expect(warnings).toEqual([]);
    expect(calls).toEqual([
      'publish:AgentA',
      'activate:bot_AgentA',
      'publish:AgentB',
      'activate:bot_AgentB',
    ]);
  });

  it('deduplicates duplicate AiAuthoringBundle entries before publishing', async () => {
    const scriptAgent = makePublishingScriptAgent({
      publish: async () => ({
        botId: '0Xx00000000001',
        botVersionId: '0XV00000000001',
        developerName: 'DataCuratorAgent',
      }),
    });
    const productionAgent = makeProductionAgent({
      activate: async () => ({ Id: '0XV00000000001', Status: 'Active' }),
    });
    agentInitMock.mockResolvedValueOnce(scriptAgent).mockResolvedValueOnce(productionAgent);

    await publishDeployedAiAuthoringBundles(
      deploymentId,
      [
        { fullName: 'DataCuratorAgent', type: 'AiAuthoringBundle', state: 'Created' },
        { fullName: 'DataCuratorAgent', type: 'AiAuthoringBundle', state: 'Changed' },
      ],
      fakeConnection,
      projectDir
    );
    expect(scriptAgent.publish).toHaveBeenCalledTimes(1);
    expect(productionAgent.activate).toHaveBeenCalledTimes(1);
  });

  it('emits a warning and skips activate when publish() throws, but continues with other bundles', async () => {
    const goodScriptAgent = makePublishingScriptAgent({
      publish: async () => ({
        botId: 'botGood',
        botVersionId: 'verGood',
        developerName: 'AgentGood',
      }),
    });
    const goodProductionAgent = makeProductionAgent({
      activate: async () => ({ Id: 'verGood', Status: 'Active' }),
    });
    const failingScriptAgent = makePublishingScriptAgent({
      publish: async () => {
        throw new Error('publish blew up');
      },
    });

    agentInitMock
      .mockResolvedValueOnce(failingScriptAgent) // publish for AgentBad
      .mockResolvedValueOnce(goodScriptAgent) // publish for AgentGood
      .mockResolvedValueOnce(goodProductionAgent); // activate for AgentGood

    const warnings = await publishDeployedAiAuthoringBundles(
      deploymentId,
      [
        { fullName: 'AgentBad', type: 'AiAuthoringBundle', state: 'Created' },
        { fullName: 'AgentGood', type: 'AiAuthoringBundle', state: 'Created' },
      ],
      fakeConnection,
      projectDir
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual({
      stage: 'agent-publish',
      errorMessage: expect.stringMatching(/AgentBad.*publish blew up/),
    });
    expect(failingScriptAgent.publish).toHaveBeenCalledTimes(1);
    expect(goodScriptAgent.publish).toHaveBeenCalledTimes(1);
    expect(goodProductionAgent.activate).toHaveBeenCalledTimes(1);
    expect(getDeploymentWarningEvents(deploymentId)).toEqual(warnings);
  });

  it('emits a warning when activate() throws but does not fail the deploy', async () => {
    const scriptAgent = makePublishingScriptAgent({
      publish: async () => ({
        botId: '0Xx00000000001',
        botVersionId: '0XV00000000001',
        developerName: 'DataCuratorAgent',
      }),
    });
    const productionAgent = makeProductionAgent({
      activate: async () => {
        throw new Error('activate denied');
      },
    });
    agentInitMock.mockResolvedValueOnce(scriptAgent).mockResolvedValueOnce(productionAgent);

    const warnings = await publishDeployedAiAuthoringBundles(
      deploymentId,
      [{ fullName: 'DataCuratorAgent', type: 'AiAuthoringBundle', state: 'Created' }],
      fakeConnection,
      projectDir
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual({
      stage: 'agent-activate',
      errorMessage: expect.stringMatching(/DataCuratorAgent.*activate denied/),
    });
    expect(scriptAgent.publish).toHaveBeenCalledTimes(1);
    expect(productionAgent.activate).toHaveBeenCalledTimes(1);
  });

  it('emits a warning and bails when SfProject.resolve fails', async () => {
    sfProjectResolveMock.mockRejectedValueOnce(new Error('not a DX project'));
    const warnings = await publishDeployedAiAuthoringBundles(
      deploymentId,
      [{ fullName: 'DataCuratorAgent', type: 'AiAuthoringBundle', state: 'Created' }],
      fakeConnection,
      projectDir
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual({
      stage: 'agent-publish',
      errorMessage: expect.stringMatching(/Could not resolve SfProject.*not a DX project/),
    });
    expect(agentInitMock).not.toHaveBeenCalled();
  });

  it('emits a warning when Agent.init throws (e.g. authoring bundle not found on disk)', async () => {
    agentInitMock.mockRejectedValueOnce(new Error('AAB not found'));
    const warnings = await publishDeployedAiAuthoringBundles(
      deploymentId,
      [{ fullName: 'Mystery', type: 'AiAuthoringBundle', state: 'Created' }],
      fakeConnection,
      projectDir
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual({
      stage: 'agent-publish',
      errorMessage: expect.stringMatching(/Mystery.*AAB not found/),
    });
  });
});
