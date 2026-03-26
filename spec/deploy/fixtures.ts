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
 * Shared test fixtures for deployment spec tests
 */
import { vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ComponentSet } from '@salesforce/source-deploy-retrieve';
import { createApp } from '../../src/app.js';

export const TEST_CREDENTIALS = {
  accessToken: 'test-access-token',
  instanceUrl: 'https://test.salesforce.com',
};

/**
 * Apply auth headers to a supertest request
 */
export function withAuthHeaders(req: ReturnType<typeof request>) {
  return req
    .set('Authorization', `Bearer ${TEST_CREDENTIALS.accessToken}`)
    .set('X-Salesforce-Instance-Url', TEST_CREDENTIALS.instanceUrl);
}

export const COMPONENT_RESPONSES = [
  { fullName: 'Hello_World__c', type: 'CustomObject', state: 'Created' },
  { fullName: 'Hello_World__c.Description__c', type: 'CustomField', state: 'Created' },
  { fullName: 'Hello_World__c.Priority__c', type: 'CustomField', state: 'Created' },
];

/**
 * Set up a temporary project directory and return project ID
 */
export async function setupTempProject(): Promise<{ tmpDir: string; projectId: string }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-deploy-test-'));
  process.env.PROJECTS_ROOT = tmpDir;

  const app = createApp();
  await app.ready();
  const createRes = await request(app.server)
    .post('/v1/projects')
    .send({ template: 'work-tracking' });
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
 * Create default mock responses for auth and connection
 */
export function setupDefaultMocks(
  mockConnectionCreate: ReturnType<typeof vi.fn>,
  mockAuthInfoCreate: ReturnType<typeof vi.fn>
): void {
  mockAuthInfoCreate.mockResolvedValue({});
  mockConnectionCreate.mockResolvedValue({});
}

/**
 * Create a successful deployment mock response
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
      numberComponentsDeployed: 3,
      numberComponentsTotal: 3,
    },
    getFileResponses: () => COMPONENT_RESPONSES,
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
