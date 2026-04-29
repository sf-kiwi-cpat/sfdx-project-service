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
 * Zero-auth deploy resolution.
 *
 * `resolveDeployAuth` lives in its own module (NOT in `auth.ts`) so that
 * `vi.mock('../../src/domain/auth.js', ...)` from the deploy spec
 * intercepts the internal `resolveAlias` call — a same-module binding
 * would be unmockable from outside. Equivalent to agent-service's
 * `SfCoreOrgAuthResolver.resolve` subclass-override pattern, adapted for
 * a function-based codebase. See `spec/deploy/contract.spec.ts`
 * IMPLEMENTATION NOTE for the full rationale.
 *
 * Priority chain for auth resolution (matches `sfdx-agent-sdk`'s
 * `SfCoreOrgAuthResolver.resolveDefault`, which itself mirrors `sf`
 * CLI's built-in `ConfigAggregator` precedence):
 *
 *   1. Body `orgAlias`                 — per-request override (always wins)
 *   2. `SF_TARGET_ORG` / `SFDX_TARGET_ORG` env var
 *   3. Project target-org (`<projectDir>/.sf/config.json`)
 *   4. Global default org (`$HOME/.sf/config.json`)
 *   5. `{ type: 'missing' }`            — caller should 400
 *
 * Priority 2–4 is delegated wholesale to `ConfigAggregator.create({
 * projectPath })`, which applies the `Environment > Local > Global`
 * ordering natively. This lets power users set `SF_TARGET_ORG` in their
 * shell for a one-shot override without mutating project state — same
 * ergonomics as `sf project deploy start`.
 */
import { ConfigAggregator, OrgConfigProperties } from '@salesforce/core';
import { logger } from '../logger.js';
import { resolveAlias } from './auth.js';

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
 * Get the effective `target-org` for a project directory, honoring the
 * Environment > Local > Global precedence that `ConfigAggregator` itself
 * applies. Returns `undefined` if no source supplies a value or if
 * `ConfigAggregator` is unavailable (never throws — failures collapse
 * to the next step in the zero-auth chain).
 */
async function getEffectiveTargetOrg(projectDir: string): Promise<string | undefined> {
  try {
    const aggregator = await ConfigAggregator.create({ projectPath: projectDir });
    const value = aggregator.getPropertyValue(OrgConfigProperties.TARGET_ORG);
    return (value as string) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve auth for a deployment using the zero-auth priority chain.
 *
 * When `bodyAlias` is provided but does not resolve to a username we
 * short-circuit with `{ type: 'unresolved-alias', alias }` rather than
 * falling through to env/project/global — the caller explicitly asked
 * for that alias, so masking the failure behind a fallback would be
 * surprising. This also lets the HTTP layer include the offending alias
 * in the problem+json `detail`.
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

  // 2-4. Delegate to ConfigAggregator for env var > project > global precedence.
  const effectiveAlias = await getEffectiveTargetOrg(projectDir);
  if (effectiveAlias) {
    const username = await resolveAlias(effectiveAlias);
    if (username) {
      logger.info({ effectiveAlias, username }, 'Using ConfigAggregator-resolved alias for auth');
      return { type: 'environment', username };
    }
  }

  // 5. No auth available
  return { type: 'missing' };
}
