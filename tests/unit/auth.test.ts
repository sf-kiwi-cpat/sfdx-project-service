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

import { writeProjectTargetOrg, resolveAlias } from '../../src/domain/auth.js';
import { resolveDeployAuth } from '../../src/domain/deploy-auth.js';
import { extractOptionalCredentials } from '../../src/utils/auth.js';

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

describe('resolveDeployAuth (zero-auth)', () => {
  // `resolveDeployAuth` now delegates Environment > Local > Global
  // precedence to `ConfigAggregator.create({ projectPath })`. These unit
  // tests stub `ConfigAggregator.create` to return a single target-org
  // value, which models whatever tier (env / local / global) the real
  // aggregator would have chosen. The deploy spec tests
  // (`spec/deploy/contract.spec.ts`) exercise the full tier-precedence
  // chain against a real `ConfigAggregator` with a hermetic `$HOME` and
  // on-disk `.sf/config.json` fixtures.
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

  it('does NOT fall back to ConfigAggregator when body alias is unresolved', async () => {
    // Explicitly failing body alias short-circuits — silently falling
    // back to env/project/global would hide the caller's intent.
    mockConfigAggregatorCreate.mockResolvedValue({
      getPropertyValue: vi.fn().mockReturnValue('project-alias'),
    });
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

  it('returns environment auth from ConfigAggregator target-org when no body alias', async () => {
    mockConfigAggregatorCreate.mockResolvedValue({
      getPropertyValue: vi.fn().mockReturnValue('my-org'),
    });
    mockStateAggregatorGetInstance.mockResolvedValue({
      aliases: { getUsername: vi.fn().mockReturnValue('user@example.com') },
    });

    const auth = await resolveDeployAuth(tmpDir);
    expect(auth).toEqual({ type: 'environment', username: 'user@example.com' });
  });

  it('returns { type: "missing" } when ConfigAggregator resolves nothing', async () => {
    mockConfigAggregatorCreate.mockResolvedValue({
      getPropertyValue: vi.fn().mockReturnValue(undefined),
    });

    const auth = await resolveDeployAuth(tmpDir);
    expect(auth).toEqual({ type: 'missing' });
  });

  it('returns { type: "missing" } when ConfigAggregator throws', async () => {
    mockConfigAggregatorCreate.mockRejectedValue(new Error('aggregator unavailable'));

    const auth = await resolveDeployAuth(tmpDir);
    expect(auth).toEqual({ type: 'missing' });
  });

  it('returns { type: "missing" } when ConfigAggregator resolves an alias that does not map to a username', async () => {
    // Aggregator returned an alias but StateAggregator does not know it —
    // the zero-auth chain falls through to `missing` rather than
    // surfacing an `unresolved-alias` (that shape is reserved for an
    // explicit body-supplied alias that the caller asked us to use).
    mockConfigAggregatorCreate.mockResolvedValue({
      getPropertyValue: vi.fn().mockReturnValue('orphaned-alias'),
    });
    mockStateAggregatorGetInstance.mockResolvedValue({
      aliases: { getUsername: vi.fn().mockReturnValue(undefined) },
    });

    const auth = await resolveDeployAuth(tmpDir);
    expect(auth).toEqual({ type: 'missing' });
  });

  it('prefers body orgAlias over ConfigAggregator-resolved alias', async () => {
    mockConfigAggregatorCreate.mockResolvedValue({
      getPropertyValue: vi.fn().mockReturnValue('project-alias'),
    });
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

  it('passes projectPath to ConfigAggregator.create so env > local > global precedence is applied natively', async () => {
    // This is the contract with `@salesforce/core`: by passing
    // `projectPath`, ConfigAggregator applies the built-in
    // Environment > Local > Global ordering (matching `sf project
    // deploy start`). We assert the call shape here; the full-chain
    // behavior is exercised by `spec/deploy/contract.spec.ts`.
    mockConfigAggregatorCreate.mockResolvedValue({
      getPropertyValue: vi.fn().mockReturnValue('resolved-alias'),
    });
    mockStateAggregatorGetInstance.mockResolvedValue({
      aliases: { getUsername: vi.fn().mockReturnValue('resolved@example.com') },
    });

    await resolveDeployAuth(tmpDir);
    expect(mockConfigAggregatorCreate).toHaveBeenCalledWith({ projectPath: tmpDir });
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
