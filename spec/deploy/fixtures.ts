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

/**
 * Shared test fixtures for deployment spec tests (zero-auth contract).
 */
import { vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ComponentSet } from '@salesforce/source-deploy-retrieve';
import { createApp } from '../../src/app.js';

/**
 * Canonical instance URL used for deriving appUrl in complete-event assertions.
 * The zero-auth contract resolves instanceUrl via @salesforce/core's
 * Connection, which is mocked in tests to return this value.
 */
export const TEST_INSTANCE_URL = 'https://test.salesforce.com';

/**
 * Legacy credentials re-exported so sibling specs written against the
 * previous header-based deploy contract (e.g. spec/react-deploy) continue
 * to compile while they migrate to the zero-auth contract. New deploy
 * spec tests MUST NOT use these — auth is resolved server-side.
 */
export const TEST_CREDENTIALS = {
  accessToken: 'test-access-token',
  instanceUrl: TEST_INSTANCE_URL,
};

export const COMPONENT_RESPONSES = [
  { fullName: 'Hello_World__c', type: 'CustomObject', state: 'Created' },
  { fullName: 'Hello_World__c.Description__c', type: 'CustomField', state: 'Created' },
  { fullName: 'Hello_World__c.Priority__c', type: 'CustomField', state: 'Created' },
  { fullName: 'App', type: 'WebApplication', state: 'Created' },
];

export const COMPONENT_RESPONSES_NO_APP = [
  { fullName: 'Hello_World__c', type: 'CustomObject', state: 'Created' },
  { fullName: 'Hello_World__c.Description__c', type: 'CustomField', state: 'Created' },
  { fullName: 'Hello_World__c.Priority__c', type: 'CustomField', state: 'Created' },
];

/**
 * Set up a temporary project directory and return project ID.
 * The created project has no target-org configured (clean slate for auth tests).
 */
export async function setupTempProject(): Promise<{ tmpDir: string; projectId: string }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-deploy-test-'));
  process.env.PROJECTS_ROOT = tmpDir;

  const app = createApp();
  await app.ready();
  const createRes = await request(app.server).post('/v1/projects').send({});
  const projectId = createRes.body.id;
  await app.close();

  return { tmpDir, projectId };
}

/**
 * Clean up temporary project directory
 */
export async function cleanupTempProject(tmpDir: string): Promise<void> {
  delete process.env.PROJECTS_ROOT;
  await fs.rm(tmpDir, { recursive: true, force: true });
}

/**
 * Write target-org to .sf/config.json under the given project dir.
 */
export async function setProjectTargetOrg(
  tmpDir: string,
  projectId: string,
  alias: string
): Promise<void> {
  const projectDir = path.join(tmpDir, projectId);
  const sfDir = path.join(projectDir, '.sf');
  await fs.mkdir(sfDir, { recursive: true });
  await fs.writeFile(path.join(sfDir, 'config.json'), JSON.stringify({ 'target-org': alias }));
}

/**
 * Remove target-org setting from a project.
 */
export async function clearProjectTargetOrg(tmpDir: string, projectId: string): Promise<void> {
  const configPath = path.join(tmpDir, projectId, '.sf', 'config.json');
  try {
    await fs.rm(configPath);
  } catch {
    // File may not exist; ignore.
  }
}

/**
 * Create default mock responses for auth and connection.
 * The ConfigAggregator/StateAggregator mocks are set up inline in the spec
 * file to allow per-test control of which alias resolves to which username.
 */
export function setupDefaultMocks(
  mockConnectionCreate: ReturnType<typeof vi.fn>,
  mockAuthInfoCreate: ReturnType<typeof vi.fn>
): void {
  mockAuthInfoCreate.mockResolvedValue({});
  mockConnectionCreate.mockResolvedValue({
    getAuthInfoFields: () => ({ instanceUrl: TEST_INSTANCE_URL }),
  });
}

/**
 * Successful deployment mock response (includes WebApplication)
 */
export function createSuccessDeployResponse(): {
  response: {
    status: string;
    numberComponentsDeployed: number;
    numberComponentsTotal: number;
  };
  getFileResponses: () => Array<{ fullName: string; type: string; state: string }>;
} {
  return {
    response: {
      status: 'Succeeded',
      numberComponentsDeployed: 4,
      numberComponentsTotal: 4,
    },
    getFileResponses: () => COMPONENT_RESPONSES,
  };
}

/**
 * Successful deployment mock response without a WebApplication component
 */
export function createSuccessDeployResponseWithoutApp(): {
  response: {
    status: string;
    numberComponentsDeployed: number;
    numberComponentsTotal: number;
  };
  getFileResponses: () => Array<{ fullName: string; type: string; state: string }>;
} {
  return {
    response: {
      status: 'Succeeded',
      numberComponentsDeployed: 3,
      numberComponentsTotal: 3,
    },
    getFileResponses: () => COMPONENT_RESPONSES_NO_APP,
  };
}

/**
 * Create an in-progress deployment mock response
 */
export function createInProgressDeployResponse(): {
  response: {
    status: string;
    numberComponentsDeployed: number;
    numberComponentsTotal: number;
  };
  getFileResponses: () => never[];
} {
  return {
    response: {
      status: 'InProgress',
      numberComponentsDeployed: 1,
      numberComponentsTotal: 3,
    },
    getFileResponses: () => [],
  };
}

/**
 * Create a failed deployment mock response
 */
export function createFailedDeployResponse(): {
  response: {
    status: string;
    numberComponentsDeployed: number;
    numberComponentsTotal: number;
    errorMessage: string;
  };
  getFileResponses: () => never[];
} {
  return {
    response: {
      status: 'Failed',
      numberComponentsDeployed: 0,
      numberComponentsTotal: 3,
      errorMessage: 'Deployment failed: invalid metadata',
    },
    getFileResponses: () => [],
  };
}

/**
 * Setup ComponentSet.deploy mock with a mock pollStatus function
 */
export function setupDeployMock(mockPollStatus: ReturnType<typeof vi.fn>): void {
  vi.spyOn(ComponentSet.prototype, 'deploy').mockResolvedValue({
    pollStatus: mockPollStatus,
    onUpdate: vi.fn().mockReturnValue(undefined),
  } as never);
}

/**
 * Describes a declared deploy stage in a template-under-test.
 */
export interface StageSpec {
  manifest: string;
  optional?: boolean;
}

/**
 * Write a minimal template tree on disk that has a template.json with
 * `deployStages` plus empty manifest XML files at the declared paths.
 * Used by staged-deploy spec tests.
 */
export async function writeStagedTemplate(projectDir: string, stages: StageSpec[]): Promise<void> {
  // Write template.json at the project root so the deploy code can discover
  // deployStages via a known name.
  const templateJson = {
    id: 'spec-staged-template',
    name: 'Staged Template (spec fixture)',
    description: 'Fixture template for staged-deploy spec tests',
    categories: ['Test'],
    deployStages: stages,
  };
  await fs.writeFile(path.join(projectDir, 'template.json'), JSON.stringify(templateJson, null, 2));

  // Minimal sfdx-project.json so SDR can root paths.
  await fs.writeFile(
    path.join(projectDir, 'sfdx-project.json'),
    JSON.stringify({
      packageDirectories: [{ path: 'force-app', default: true }],
      sourceApiVersion: '66.0',
    })
  );

  // Write each referenced manifest file with a minimal but valid Package XML.
  for (const stage of stages) {
    const manifestPath = path.join(projectDir, stage.manifest);
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(
      manifestPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
  <version>64.0</version>
</Package>
`
    );
  }

  // Create an empty force-app/main/default directory so ComponentSet.fromSource
  // has somewhere to root itself if it is used as a fallback.
  await fs.mkdir(path.join(projectDir, 'force-app', 'main', 'default'), {
    recursive: true,
  });
}

/**
 * Set up a staged-template project: tmpdir + PROJECTS_ROOT + created project
 * + staged-template files on disk.
 */
export async function setupStagedTemplateProject(opts: {
  stages: StageSpec[];
}): Promise<{ tmpDir: string; projectId: string }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-deploy-staged-test-'));
  process.env.PROJECTS_ROOT = tmpDir;

  const app = createApp();
  await app.ready();
  const createRes = await request(app.server).post('/v1/projects').send({});
  const projectId = createRes.body.id;
  await app.close();

  const projectDir = path.join(tmpDir, projectId);
  await writeStagedTemplate(projectDir, opts.stages);

  return { tmpDir, projectId };
}

/**
 * Clean up a staged-template project fixture.
 */
export async function cleanupStagedTemplateProject(tmpDir: string): Promise<void> {
  delete process.env.PROJECTS_ROOT;
  await fs.rm(tmpDir, { recursive: true, force: true });
}
