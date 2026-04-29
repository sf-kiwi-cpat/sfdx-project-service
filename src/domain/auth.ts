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
 * Auth resolution for deployments (zero-auth contract).
 *
 * The HTTP surface does NOT accept caller-supplied credentials.
 * Auth is resolved server-side from the CLI environment in this priority order:
 *   1. Request-body `orgAlias` (per-request override)
 *   2. Project target-org (written to `.sf/config.json` at project creation)
 *   3. Global default org (ConfigAggregator `target-org` property)
 *   4. Returns `{ type: 'missing' }` — caller should 400
 *
 * If a body-supplied alias does not resolve to a username, we return
 * `{ type: 'unresolved-alias', alias }` so the caller can include the
 * offending alias in the problem+json `detail` (generic "alias not
 * resolved" without the value is unhelpful to the caller).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { StateAggregator, ConfigAggregator, OrgConfigProperties } from '@salesforce/core';
import { logger } from '../logger.js';

/**
 * Resolved auth information. Either username-based (environment) or
 * credential-based (legacy, retained for backward compatibility with
 * sibling specs that predate the zero-auth contract).
 */
export type ResolvedAuth =
  | { type: 'environment'; username: string }
  | { type: 'credentials'; accessToken: string; instanceUrl: string };

/**
 * Outcome of auth resolution for a deployment request.
 *
 * - `ResolvedAuth` on success
 * - `{ type: 'missing' }` when no auth source is available
 * - `{ type: 'unresolved-alias', alias }` when the body-supplied alias
 *   did not resolve to a username (so the caller can mention it in the
 *   400 error)
 */
export type AuthResolution =
  | ResolvedAuth
  | { type: 'missing' }
  | { type: 'unresolved-alias'; alias: string };

/**
 * Read the target-org alias from a project's .sf/config.json.
 * Returns undefined if the file doesn't exist or has no target-org.
 */
export async function readProjectTargetOrg(projectDir: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(projectDir, '.sf', 'config.json'), 'utf-8');
    const config = JSON.parse(raw) as Record<string, string>;
    return config['target-org'] || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write the target-org alias to a project's .sf/config.json.
 */
export async function writeProjectTargetOrg(projectDir: string, alias: string): Promise<void> {
  const sfDir = path.join(projectDir, '.sf');
  await fs.mkdir(sfDir, { recursive: true });
  await fs.writeFile(path.join(sfDir, 'config.json'), JSON.stringify({ 'target-org': alias }));
}

/**
 * Resolve an org alias to a username via the Salesforce StateAggregator.
 * Returns undefined if the alias is not found or StateAggregator is unavailable.
 */
export async function resolveAlias(alias: string): Promise<string | undefined> {
  try {
    const stateAggregator = await StateAggregator.getInstance();
    return stateAggregator.aliases.getUsername(alias) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Get the global default target-org alias from ConfigAggregator.
 * Returns undefined if no global default is configured or ConfigAggregator is unavailable.
 */
export async function getGlobalDefaultOrg(): Promise<string | undefined> {
  try {
    const configAggregator = await ConfigAggregator.create();
    const value = configAggregator.getPropertyValue(OrgConfigProperties.TARGET_ORG);
    return (value as string) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve auth for a deployment using the zero-auth priority chain:
 *   1. Body `orgAlias` (per-request override)
 *   2. Project target-org (`.sf/config.json`)
 *   3. Global default org (`ConfigAggregator`)
 *   4. `{ type: 'missing' }` when none available
 *
 * When `bodyAlias` is provided but does not resolve to a username we
 * short-circuit with `{ type: 'unresolved-alias', alias }` rather than
 * falling through to project/global — the caller explicitly asked for
 * that alias, so masking the failure behind a fallback would be
 * surprising. This also lets the HTTP layer include the offending
 * alias in the problem+json `detail`.
 */
export async function resolveDeployAuth(
  projectDir: string,
  bodyAlias?: string
): Promise<AuthResolution> {
  // 1. Body orgAlias (highest priority — caller-supplied per-request override)
  if (bodyAlias) {
    const username = await resolveAlias(bodyAlias);
    if (username) {
      logger.info({ bodyAlias, username }, 'Using body orgAlias for auth');
      return { type: 'environment', username };
    }
    return { type: 'unresolved-alias', alias: bodyAlias };
  }

  // 2. Project-level target-org
  const projectTargetOrg = await readProjectTargetOrg(projectDir);
  if (projectTargetOrg) {
    const username = await resolveAlias(projectTargetOrg);
    if (username) {
      logger.info({ projectTargetOrg, username }, 'Using project target-org for auth');
      return { type: 'environment', username };
    }
  }

  // 3. Global default org
  const globalDefault = await getGlobalDefaultOrg();
  if (globalDefault) {
    const username = await resolveAlias(globalDefault);
    if (username) {
      logger.info({ globalDefault, username }, 'Using global default org for auth');
      return { type: 'environment', username };
    }
  }

  // 4. No auth available
  return { type: 'missing' };
}
