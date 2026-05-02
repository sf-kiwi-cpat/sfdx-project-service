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
import { StateAggregator } from '@salesforce/core';

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
 * Write the target-org alias to a project's .sf/config.json.
 * Called by `projects.ts` when a user pins an `orgAlias` at project
 * creation time; the deploy chain later reads this via
 * `ConfigAggregator.create({ projectPath })` in `deploy-auth.ts`.
 */
export async function writeProjectTargetOrg(projectDir: string, alias: string): Promise<void> {
  const sfDir = path.join(projectDir, '.sf');
  await fs.mkdir(sfDir, { recursive: true });
  await fs.writeFile(path.join(sfDir, 'config.json'), JSON.stringify({ 'target-org': alias }));
}
