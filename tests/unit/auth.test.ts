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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Mock @salesforce/core
const { mockStateAggregatorGetInstance, mockConfigAggregatorCreate } = vi.hoisted(() => ({
  mockStateAggregatorGetInstance: vi.fn(),
  mockConfigAggregatorCreate: vi.fn(),
}));

vi.mock('@salesforce/core', () => ({
  StateAggregator: { getInstance: mockStateAggregatorGetInstance },
  ConfigAggregator: { create: mockConfigAggregatorCreate },
  OrgConfigProperties: { TARGET_ORG: 'target-org' },
}));

import {
  readProjectTargetOrg,
  writeProjectTargetOrg,
  resolveAlias,
  getGlobalDefaultOrg,
  resolveDeployAuth,
} from '../../src/domain/auth.js';
import { extractOptionalCredentials } from '../../src/utils/auth.js';

describe('readProjectTargetOrg', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-auth-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns the target-org when .sf/config.json exists', async () => {
    await fs.mkdir(path.join(tmpDir, '.sf'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.sf', 'config.json'),
      JSON.stringify({ 'target-org': 'my-org' })
    );
    expect(await readProjectTargetOrg(tmpDir)).toBe('my-org');
  });

  it('returns undefined when .sf/config.json does not exist', async () => {
    expect(await readProjectTargetOrg(tmpDir)).toBeUndefined();
  });

  it('returns undefined when target-org is empty string', async () => {
    await fs.mkdir(path.join(tmpDir, '.sf'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.sf', 'config.json'),
      JSON.stringify({ 'target-org': '' })
    );
    expect(await readProjectTargetOrg(tmpDir)).toBeUndefined();
  });
});

describe('writeProjectTargetOrg', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-auth-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes target-org to .sf/config.json', async () => {
    await writeProjectTargetOrg(tmpDir, 'my-org');
    const raw = await fs.readFile(path.join(tmpDir, '.sf', 'config.json'), 'utf-8');
    const config = JSON.parse(raw);
    expect(config['target-org']).toBe('my-org');
  });

  it('creates .sf directory if it does not exist', async () => {
    await writeProjectTargetOrg(tmpDir, 'another-org');
    const stat = await fs.stat(path.join(tmpDir, '.sf'));
    expect(stat.isDirectory()).toBe(true);
  });
});

describe('resolveAlias', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns username when alias exists', async () => {
    mockStateAggregatorGetInstance.mockResolvedValue({
      aliases: { getUsername: vi.fn().mockReturnValue('user@example.com') },
    });
    expect(await resolveAlias('my-alias')).toBe('user@example.com');
  });

  it('returns undefined when alias is not found', async () => {
    mockStateAggregatorGetInstance.mockResolvedValue({
      aliases: { getUsername: vi.fn().mockReturnValue(undefined) },
    });
    expect(await resolveAlias('unknown')).toBeUndefined();
  });

  it('returns undefined when alias resolves to null', async () => {
    mockStateAggregatorGetInstance.mockResolvedValue({
      aliases: { getUsername: vi.fn().mockReturnValue(null) },
    });
    expect(await resolveAlias('null-alias')).toBeUndefined();
  });

  it('returns undefined when StateAggregator.getInstance throws', async () => {
    mockStateAggregatorGetInstance.mockRejectedValue(new Error('not available'));
    expect(await resolveAlias('any')).toBeUndefined();
  });
});

describe('getGlobalDefaultOrg', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the global default org alias', async () => {
    mockConfigAggregatorCreate.mockResolvedValue({
      getPropertyValue: vi.fn().mockReturnValue('global-org'),
    });
    expect(await getGlobalDefaultOrg()).toBe('global-org');
  });

  it('returns undefined when no global default', async () => {
    mockConfigAggregatorCreate.mockResolvedValue({
      getPropertyValue: vi.fn().mockReturnValue(undefined),
    });
    expect(await getGlobalDefaultOrg()).toBeUndefined();
  });

  it('returns undefined when global default is empty string', async () => {
    mockConfigAggregatorCreate.mockResolvedValue({
      getPropertyValue: vi.fn().mockReturnValue(''),
    });
    expect(await getGlobalDefaultOrg()).toBeUndefined();
  });

  it('returns undefined when ConfigAggregator.create throws', async () => {
    mockConfigAggregatorCreate.mockRejectedValue(new Error('not available'));
    expect(await getGlobalDefaultOrg()).toBeUndefined();
  });
});

describe('resolveDeployAuth (zero-auth)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-auth-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns environment auth from body orgAlias (highest priority)', async () => {
    mockStateAggregatorGetInstance.mockResolvedValue({
      aliases: {
        getUsername: vi
          .fn()
          .mockImplementation((alias: string) =>
            alias === 'body-alias' ? 'body@example.com' : undefined
          ),
      },
    });

    const auth = await resolveDeployAuth(tmpDir, 'body-alias');
    expect(auth).toEqual({ type: 'environment', username: 'body@example.com' });
  });

  it('returns unresolved-alias when body orgAlias does not resolve', async () => {
    mockStateAggregatorGetInstance.mockResolvedValue({
      aliases: { getUsername: vi.fn().mockReturnValue(undefined) },
    });

    const auth = await resolveDeployAuth(tmpDir, 'unknown-alias');
    expect(auth).toEqual({ type: 'unresolved-alias', alias: 'unknown-alias' });
  });

  it('does NOT fall back to project target-org when body alias is unresolved', async () => {
    // Explicitly failing body alias short-circuits — silently falling
    // back to project/global would hide the caller's intent.
    await fs.mkdir(path.join(tmpDir, '.sf'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.sf', 'config.json'),
      JSON.stringify({ 'target-org': 'project-alias' })
    );
    mockStateAggregatorGetInstance.mockResolvedValue({
      aliases: {
        getUsername: vi
          .fn()
          .mockImplementation((alias: string) =>
            alias === 'project-alias' ? 'project@example.com' : undefined
          ),
      },
    });

    const auth = await resolveDeployAuth(tmpDir, 'unknown-alias');
    expect(auth).toEqual({ type: 'unresolved-alias', alias: 'unknown-alias' });
  });

  it('returns environment auth from project target-org when no body alias', async () => {
    await fs.mkdir(path.join(tmpDir, '.sf'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.sf', 'config.json'),
      JSON.stringify({ 'target-org': 'my-org' })
    );
    mockStateAggregatorGetInstance.mockResolvedValue({
      aliases: { getUsername: vi.fn().mockReturnValue('user@example.com') },
    });

    const auth = await resolveDeployAuth(tmpDir);
    expect(auth).toEqual({ type: 'environment', username: 'user@example.com' });
  });

  it('returns environment auth from global default when no body/project config', async () => {
    mockConfigAggregatorCreate.mockResolvedValue({
      getPropertyValue: vi.fn().mockReturnValue('global-org'),
    });
    mockStateAggregatorGetInstance.mockResolvedValue({
      aliases: { getUsername: vi.fn().mockReturnValue('global-user@example.com') },
    });

    const auth = await resolveDeployAuth(tmpDir);
    expect(auth).toEqual({ type: 'environment', username: 'global-user@example.com' });
  });

  it('returns { type: "missing" } when no auth source is available', async () => {
    mockConfigAggregatorCreate.mockResolvedValue({
      getPropertyValue: vi.fn().mockReturnValue(undefined),
    });

    const auth = await resolveDeployAuth(tmpDir);
    expect(auth).toEqual({ type: 'missing' });
  });

  it('prefers body orgAlias over project target-org', async () => {
    await fs.mkdir(path.join(tmpDir, '.sf'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.sf', 'config.json'),
      JSON.stringify({ 'target-org': 'project-alias' })
    );
    mockStateAggregatorGetInstance.mockResolvedValue({
      aliases: {
        getUsername: vi.fn().mockImplementation((alias: string) => {
          if (alias === 'body-alias') return 'body@example.com';
          if (alias === 'project-alias') return 'project@example.com';
          return undefined;
        }),
      },
    });

    const auth = await resolveDeployAuth(tmpDir, 'body-alias');
    expect(auth).toEqual({ type: 'environment', username: 'body@example.com' });
  });

  it('prefers project target-org over global default', async () => {
    await fs.mkdir(path.join(tmpDir, '.sf'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.sf', 'config.json'),
      JSON.stringify({ 'target-org': 'project-alias' })
    );
    mockConfigAggregatorCreate.mockResolvedValue({
      getPropertyValue: vi.fn().mockReturnValue('global-alias'),
    });
    mockStateAggregatorGetInstance.mockResolvedValue({
      aliases: {
        getUsername: vi.fn().mockImplementation((alias: string) => {
          if (alias === 'project-alias') return 'project@example.com';
          if (alias === 'global-alias') return 'global@example.com';
          return undefined;
        }),
      },
    });

    const auth = await resolveDeployAuth(tmpDir);
    expect(auth).toEqual({ type: 'environment', username: 'project@example.com' });
  });
});

describe('extractOptionalCredentials', () => {
  function mockRequest(headers: Record<string, string | undefined>) {
    return { headers } as never;
  }

  it('returns credentials when both headers are present and valid', () => {
    const result = extractOptionalCredentials(
      mockRequest({
        authorization: 'Bearer my-token',
        'x-salesforce-instance-url': 'https://test.salesforce.com',
      })
    );
    expect(result).toEqual({
      accessToken: 'my-token',
      instanceUrl: 'https://test.salesforce.com',
    });
  });

  it('returns null when Authorization header is missing', () => {
    const result = extractOptionalCredentials(
      mockRequest({
        'x-salesforce-instance-url': 'https://test.salesforce.com',
      })
    );
    expect(result).toBeNull();
  });

  it('returns null when instance URL header is missing', () => {
    const result = extractOptionalCredentials(
      mockRequest({
        authorization: 'Bearer my-token',
      })
    );
    expect(result).toBeNull();
  });

  it('returns null when both headers are missing', () => {
    const result = extractOptionalCredentials(mockRequest({}));
    expect(result).toBeNull();
  });

  it('returns null when instance URL is not a valid URL', () => {
    const result = extractOptionalCredentials(
      mockRequest({
        authorization: 'Bearer my-token',
        'x-salesforce-instance-url': 'not-a-url',
      })
    );
    expect(result).toBeNull();
  });

  it('returns null when Authorization does not start with Bearer', () => {
    const result = extractOptionalCredentials(
      mockRequest({
        authorization: 'Basic my-token',
        'x-salesforce-instance-url': 'https://test.salesforce.com',
      })
    );
    expect(result).toBeNull();
  });
});
