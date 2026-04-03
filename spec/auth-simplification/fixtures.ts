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
 * Shared test fixtures for auth simplification spec tests
 */
import { vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

export const TEST_ORG_ALIAS = 'my-scratch-org';
export const TEST_USERNAME = 'test-user@example.com';
export const TEST_INSTANCE_URL = 'https://test.my.salesforce.com';

/**
 * Configure StateAggregator mock to resolve aliases.
 * Default: TEST_ORG_ALIAS → TEST_USERNAME
 */
export function setupStateAggregatorMock(
  mockGetInstance: ReturnType<typeof vi.fn>,
  aliasMap: Record<string, string | undefined> = { [TEST_ORG_ALIAS]: TEST_USERNAME }
): void {
  mockGetInstance.mockResolvedValue({
    aliases: {
      getUsername: vi.fn().mockImplementation((alias: string) => aliasMap[alias]),
    },
  });
}

/**
 * Configure ConfigAggregator mock to return a global default target-org.
 * Pass undefined to simulate no global default.
 */
export function setupConfigAggregatorMock(
  mockCreate: ReturnType<typeof vi.fn>,
  globalTargetOrg?: string
): void {
  mockCreate.mockResolvedValue({
    getPropertyValue: vi.fn().mockReturnValue(globalTargetOrg),
  });
}

/**
 * Write a target-org config to a project's .sf/config.json
 */
export async function setupProjectTargetOrg(projectDir: string, alias: string): Promise<void> {
  const sfDir = path.join(projectDir, '.sf');
  await fs.mkdir(sfDir, { recursive: true });
  await fs.writeFile(path.join(sfDir, 'config.json'), JSON.stringify({ 'target-org': alias }));
}

/**
 * Read the target-org from a project's .sf/config.json.
 * Returns undefined if the file doesn't exist.
 */
export async function readProjectTargetOrg(projectDir: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(projectDir, '.sf', 'config.json'), 'utf-8');
    const config = JSON.parse(raw) as Record<string, string>;
    return config['target-org'];
  } catch {
    return undefined;
  }
}

/**
 * Remove any .sf config directory from a project (clean slate for tests)
 */
export async function cleanupProjectConfig(projectDir: string): Promise<void> {
  await fs.rm(path.join(projectDir, '.sf'), { recursive: true, force: true });
}

/**
 * Set up default Connection mock with refreshAuth and getAuthInfoFields.
 * Used for environment auth path where the connection is created from
 * stored credentials rather than per-request headers.
 */
export function setupEnvironmentAuthMocks(
  mockConnectionCreate: ReturnType<typeof vi.fn>,
  mockAuthInfoCreate: ReturnType<typeof vi.fn>
): void {
  mockAuthInfoCreate.mockResolvedValue({});
  mockConnectionCreate.mockResolvedValue({
    refreshAuth: vi.fn().mockResolvedValue(undefined),
    getAuthInfoFields: vi.fn().mockReturnValue({ instanceUrl: TEST_INSTANCE_URL }),
  });
}
