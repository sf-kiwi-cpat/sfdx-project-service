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
 * Auth resolution for deployments.
 *
 * Priority:
 * 1. Project-level target-org (from .sf/config.json)
 * 2. Global default org (from SFDX global config via ConfigAggregator)
 * 3. Legacy credential headers (Authorization + X-Salesforce-Instance-Url)
 * 4. null if none available
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { StateAggregator, ConfigAggregator, OrgConfigProperties } from '@salesforce/core';
import { logger } from '../logger.js';

/**
 * Resolved auth information. Either username-based (environment) or
 * credential-based (legacy headers).
 */
export type ResolvedAuth =
  | { type: 'environment'; username: string }
  | { type: 'credentials'; accessToken: string; instanceUrl: string };

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
 * Resolve auth for a deployment using the priority chain:
 * 1. Project-level target-org
 * 2. Global default org
 * 3. Legacy credential headers
 * 4. null if none available
 */
export async function resolveDeployAuth(
  projectDir: string,
  headerCredentials?: { accessToken: string; instanceUrl: string }
): Promise<ResolvedAuth | null> {
  // 1. Check project-level target-org
  const projectTargetOrg = await readProjectTargetOrg(projectDir);
  if (projectTargetOrg) {
    const username = await resolveAlias(projectTargetOrg);
    if (username) {
      logger.info({ projectTargetOrg, username }, 'Using project target-org for auth');
      return { type: 'environment', username };
    }
  }

  // 2. Check global default org
  const globalDefault = await getGlobalDefaultOrg();
  if (globalDefault) {
    const username = await resolveAlias(globalDefault);
    if (username) {
      logger.info({ globalDefault, username }, 'Using global default org for auth');
      return { type: 'environment', username };
    }
  }

  // 3. Fall back to credential headers
  if (headerCredentials) {
    logger.info('Using legacy credential headers for auth');
    return {
      type: 'credentials',
      accessToken: headerCredentials.accessToken,
      instanceUrl: headerCredentials.instanceUrl,
    };
  }

  // 4. No auth available
  return null;
}
