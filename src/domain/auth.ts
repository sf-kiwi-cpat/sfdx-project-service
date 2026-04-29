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
 * Auth leaf module (zero-auth contract).
 *
 * This module is the alias→username lookup leaf AND the project/global
 * target-org I/O helper layer. It is deliberately kept free of the
 * `resolveDeployAuth` orchestrator: `resolveDeployAuth` lives in
 * `deploy-auth.ts` and imports `resolveAlias` FROM this module with a
 * static named import. That arrangement lets the deploy spec's
 * `vi.mock('../../src/domain/auth.js', ...)` replace `resolveAlias` at
 * the module boundary and have the replacement take effect INSIDE
 * `resolveDeployAuth`. If `resolveDeployAuth` lived in this same file,
 * the call would be a same-module binding and unmockable. Equivalent to
 * agent-service's `SfCoreOrgAuthResolver.resolve` subclass-override
 * pattern, adapted for a function-based codebase.
 *
 * The HTTP surface does NOT accept caller-supplied credentials.
 * `Authorization` and `X-Salesforce-Instance-Url` headers are not part
 * of the contract; if sent, they are ignored.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { StateAggregator, ConfigAggregator, OrgConfigProperties } from '@salesforce/core';

/**
 * Resolve an org alias to a username via the Salesforce StateAggregator.
 * Returns undefined if the alias is not found or StateAggregator is
 * unavailable. Never throws — failures collapse to `undefined` so the
 * caller can branch on the zero-auth priority chain cleanly.
 *
 * Contract-critical: this function is mocked at the module boundary by
 * `spec/deploy/contract.spec.ts`. Do not inline or move its definition
 * without updating the spec test's mock target.
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
 * Read the target-org alias from a project's .sf/config.json.
 * Returns undefined if the file doesn't exist or has no target-org.
 *
 * Retained as a standalone helper (separate from the deploy chain's
 * `ConfigAggregator.create({ projectPath })`) because other callers —
 * notably `domain/projects.ts` — need to inspect the on-disk project
 * config without paying the full `ConfigAggregator` load cost or being
 * influenced by env vars / global defaults.
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
 * Get the global default target-org alias from ConfigAggregator.
 * Returns undefined if no global default is configured or
 * ConfigAggregator is unavailable.
 *
 * Kept as a separate export (rather than only reading it through
 * `resolveDeployAuth`) so unit tests and tooling can inspect the global
 * default in isolation. The zero-auth deploy chain now resolves
 * env/local/global together via `ConfigAggregator.create({ projectPath })`
 * inside `deploy-auth.ts` and does not call this helper directly.
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
