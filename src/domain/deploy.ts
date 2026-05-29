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

import fs from 'node:fs/promises';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ComponentSet } from '@salesforce/source-deploy-retrieve';
import { Connection, AuthInfo } from '@salesforce/core';
import { logger } from '../logger.js';
import { type ResolvedAuth } from './deploy-auth.js';
import {
  setDeploymentResult,
  setDeploymentError,
  addProgressEvent,
  addStageEvent,
  addWarningEvent,
  type DeploymentResult,
  type ProgressEvent,
  type DeploymentComponentResult,
  type DeploymentStageSummary,
  type DeploymentWarning,
} from '../deployments.js';
import { hasReactFiles, runViteBuild } from './build.js';
import { BuildError } from '../errors.js';

/**
 * Rewrite an org instance URL to the canonical "Salesforce App" domain
 * used by deployed UIBundle (React/LWR) apps. Cookie-auth REST calls
 * from the deployed app are only allow-listed when the page is served
 * from this domain — direct nav to the same path on `*.my.salesforce.com`
 * 401s on every Connect API call (W-22404059).
 *
 *   https://orgfarm-1fa1bb3933.test1.my.pc-rnd.salesforce.com
 *   →
 *   https://orgfarm-1fa1bb3933--c.test1.my.pc-rnd.salesforce.app
 *
 * The swap is two edits: append `--c` to the leftmost host label
 * (the namespace marker required by core's SalesforceAppDomainFilter)
 * and change the TLD from `salesforce.com` to `salesforce.app`.
 *
 * Returns `null` when the input doesn't match the expected shape so
 * call sites can fall back to the unmodified instance URL rather than
 * surface a fabricated host. Already-app-domain URLs and inputs whose
 * leftmost label already carries a `--<ns>` suffix are passed through
 * unchanged.
 *
 * Note that the `--c` host only resolves once the target org has the
 * `salesforceAppDomain` org pref enabled — that's a separate operator
 * step (per W-22404059 follow-up). Until then the toast points at a
 * non-resolving host; that's still preferable to today's behavior of
 * pointing at a resolving host where every API call 401s.
 */
export function toAppDomainUrl(instanceUrl: string): string | null {
  const match = instanceUrl.match(/^(https?:\/\/)([^/]+)(.*)$/);
  if (!match) return null;
  const [, scheme, host, rest] = match;
  if (host.endsWith('.salesforce.app')) return instanceUrl;
  if (!host.endsWith('.salesforce.com')) return null;
  const labels = host.split('.');
  const firstLabel = labels[0];
  if (!firstLabel || firstLabel.includes('--')) return null;
  labels[0] = `${firstLabel}--c`;
  labels[labels.length - 1] = 'app';
  return `${scheme}${labels.join('.')}${rest}`;
}

/**
 * A single stage in a multi-manifest deploy. Declared in a template's
 * `template.json` under `deployStages`. Templates that do not declare
 * `deployStages` run a single-pass `ComponentSet.fromSource(force-app)`
 * deploy for backward compatibility.
 */
export interface DeployStage {
  manifest: string;
  optional?: boolean;
}

/**
 * Assign each PermissionSet that landed in the deploy to the deploying
 * user, skipping any already assigned. Idempotent on re-deploys.
 *
 * Salesforce's Metadata API never auto-assigns permission sets — even
 * when the deploying user is a System Admin. Templates that ship a
 * permset rely on this assignment to grant the calling user FLS on
 * optional fields (System Admin auto-grants FLS only on `<required>true</required>`
 * fields), so without it, Apex SOQL surfaces optional fields as
 * "No such column".
 *
 * Failures here are logged as warnings on the deployment, not raised:
 * the metadata is correctly in place, the deploy itself succeeded, and
 * a missing assignment is a recoverable problem (the user can self-assign
 * via Setup) — surfacing it as a deploy failure would be a regression
 * for templates that don't ship a permset.
 */
export async function assignDeployedPermissionSets(
  deploymentId: string,
  fileResponses: Array<{ fullName: string; type: string; state: string }>,
  connection: Connection
): Promise<DeploymentWarning[]> {
  const permissionSetNames = Array.from(
    new Set(fileResponses.filter((f) => f.type === 'PermissionSet').map((f) => f.fullName))
  );
  if (permissionSetNames.length === 0) {
    return [];
  }

  // userId resolution: prefer the AuthInfo cache (cheap, no SOQL), fall back
  // to a `User WHERE Username` lookup when AuthInfo doesn't carry it. The
  // vaas-test container's auth flow seeds the cache via `sfdx auth:web:login`
  // output that doesn't include the user_id field, so getAuthInfoFields()
  // returns undefined there even though the connection itself is valid.
  const authFields = connection.getAuthInfoFields();
  let userId = authFields.userId;
  if (!userId && authFields.username) {
    const userQuery = await connection.query<{ Id: string }>(
      `SELECT Id FROM User WHERE Username = '${authFields.username}' LIMIT 1`
    );
    userId = userQuery.records[0]?.Id;
  }
  if (!userId) {
    const warning: DeploymentWarning = {
      stage: 'permset-assignment',
      errorMessage: 'Could not resolve deploying userId; skipping PermissionSet auto-assignment',
    };
    addWarningEvent(deploymentId, warning);
    return [warning];
  }

  const psQuery = await connection.query<{ Id: string; Name: string }>(
    `SELECT Id, Name FROM PermissionSet WHERE Name IN ('${permissionSetNames.join("','")}')`
  );
  const idsByName = new Map(psQuery.records.map((r) => [r.Name, r.Id]));

  const existingAssignments = await connection.query<{ PermissionSetId: string }>(
    `SELECT PermissionSetId FROM PermissionSetAssignment WHERE AssigneeId = '${userId}' AND PermissionSetId IN ('${Array.from(idsByName.values()).join("','")}')`
  );
  const alreadyAssigned = new Set(existingAssignments.records.map((r) => r.PermissionSetId));

  const warnings: DeploymentWarning[] = [];
  for (const name of permissionSetNames) {
    const psId = idsByName.get(name);
    if (!psId) {
      const warning: DeploymentWarning = {
        stage: 'permset-assignment',
        errorMessage: `PermissionSet '${name}' was reported deployed but not found in the org; skipping assignment`,
      };
      warnings.push(warning);
      addWarningEvent(deploymentId, warning);
      continue;
    }
    if (alreadyAssigned.has(psId)) continue;

    const result = await connection.sobject('PermissionSetAssignment').create({
      AssigneeId: userId,
      PermissionSetId: psId,
    });
    if (!result.success) {
      const errs = (result.errors ?? []).map((e) => e.message ?? String(e)).join('; ');
      const warning: DeploymentWarning = {
        stage: 'permset-assignment',
        errorMessage: `Failed to assign PermissionSet '${name}': ${errs}`,
      };
      warnings.push(warning);
      addWarningEvent(deploymentId, warning);
    } else {
      logger.info({ deploymentId, permissionSet: name, userId }, 'Assigned PermissionSet');
    }
  }
  return warnings;
}

/**
 * Publish + activate every AiAuthoringBundle that landed in the deploy.
 *
 * Deploying an AiAuthoringBundle ships the source file (the `.agent`
 * script + `bundle-meta.xml`) but does NOT materialize the runtime
 * BotDefinition / BotVersion in the org — that's a separate compile
 * + publish API call that the Salesforce CLI's `sf agent publish`
 * wraps. Until publish runs, the deployed bundle is not invocable
 * (chat panel returns "agent not found"); after publish, a new
 * BotVersion exists in `Inactive` state and a follow-up activate is
 * required to set `Status = Active`.
 *
 * Originally this hook called `Agent.init` from `@salesforce/agents`
 * directly in-process — same code the `sf agent publish` CLI wraps,
 * but invoked as a library import to avoid the CLI's subprocess
 * overhead, DX-project assumptions, and `SF_TEST_API` env quirks.
 *
 * ## Why we fork a child process instead
 *
 * `@salesforce/agents@1.6.x` declares `nock` as a *runtime* dependency
 * (not devDependency). Importing the library transitively imports
 * `lib/maybe-mock.js`, which `require()`s `nock`, whose module-init
 * constructs a `BatchInterceptor` from `@mswjs/interceptors` and
 * monkey-patches `http.ClientRequest` and `http.request` globally —
 * see `node_modules/@mswjs/interceptors/lib/node/ClientRequest-*.cjs`,
 * which `MockHttpSocket`-wraps every outgoing socket. The result: any
 * deploy in the same Node process that imports `@salesforce/agents`
 * sees its SOAP / metadata API calls fail with `read EINVAL` because
 * the mock socket aborts requests it doesn't have a matching scope for.
 *
 * Concretely: even templates that ship NO AiAuthoringBundle were
 * failing to deploy because `import { Agent } from '@salesforce/agents'`
 * at the top of this file fired nock's side effect at module-load
 * time — long before the bundleNames check ran.
 *
 * Forking a child process for the publish + activate calls contains
 * the side effect:
 *   - The parent project-service stays clean for the metadata-deploy
 *     phase (which always runs before this hook, in any case).
 *   - The child's nock pollution dies with the process when it exits.
 *   - Cold-start cost (~500ms-1s for `Agent` init) is bounded — only
 *     fires when an AiAuthoringBundle is in the deploy. The deploy
 *     itself is the slow part (~30s), so this is not user-visible.
 *
 * ## Stop-gap, not durable
 *
 * This is a stop-gap. The real fix belongs upstream in
 * `@salesforce/agents`: `nock` should move to `devDependencies`, and
 * `lib/maybe-mock.js` should not be imported on the production code
 * path (or should lazy-require nock only when `SF_MOCK_DIR` is set).
 *
 * Once that lands and we bump our pinned version, this hook should
 * collapse back to an in-process call. The relevant changes to revert:
 *   - Delete `src/domain/publish-aab-child.ts`.
 *   - Restore the in-process `Agent.init` + `publish` + `activate`
 *     calls here, including the `getDefaultPackage` workaround (see
 *     publish-aab-child.ts for the original shape and rationale —
 *     that workaround is independent of the nock issue and may also
 *     be fixed by then).
 *   - Drop `username` from the parameter list — the in-process path
 *     reuses the parent's `connection` directly.
 *
 * ## Idempotency
 *
 * Republishing an already-published bundle is tolerated — the publish
 * API creates a new BotVersion N+1 against the existing BotDefinition.
 * Activate then targets the latest version.
 *
 * ## Error contract
 *
 * Failures emit warning SSE events on the deployment but do not raise:
 * the metadata is in place, the deploy itself succeeded, and a missing
 * publish/activate is recoverable (the user can run `sf agent publish`
 * + `sf agent activate` manually). Surfacing as a deploy failure would
 * regress templates that don't ship an AiAuthoringBundle.
 *
 * No-op when the deploy ships zero AiAuthoringBundle components.
 */

interface ChildSuccess {
  ok: true;
  botId: string;
  botVersionId: string;
  botVersionStatus: string;
}
interface ChildFailure {
  ok: false;
  stage: 'agent-init' | 'agent-publish' | 'agent-activate' | 'sfproject-resolve' | 'connection';
  errorMessage: string;
}
type ChildResult = ChildSuccess | ChildFailure;

/**
 * Resolve the on-disk path to the compiled child entry point.
 *
 * `import.meta.url` resolves to `dist/domain/deploy.js` at runtime, so
 * the sibling child script sits at `./publish-aab-child.js`. Exported
 * so tests can stub it without re-deriving the path themselves.
 */
export function resolvePublishAabChildPath(): string {
  return fileURLToPath(new URL('./publish-aab-child.js', import.meta.url));
}

/**
 * Fork the publish-aab child for a single bundle. Resolves to the
 * structured ChildResult parsed from the child's stdout, or rejects if
 * the child cannot be spawned, exits without emitting a parsable
 * result, or stays alive past the timeout.
 *
 * Exposed via `runPublishAabChildImpl` so unit tests can swap the
 * fork+IPC plumbing for a stub without monkey-patching `child_process`.
 */
export async function runPublishAabChildImpl(
  childPath: string,
  input: { username: string; projectDir: string; aabName: string }
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    // `silent: true` pipes the child's stdio to us so we can read its
    // single-line JSON result. `stderr` is forwarded to our stderr so
    // pino logs from inside @salesforce/agents still surface in the
    // parent's log stream.
    const child = fork(childPath, [], {
      silent: true,
      stdio: ['pipe', 'pipe', 'inherit', 'ipc'],
    });
    let stdout = '';
    let settled = false;
    const finalize = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.on('error', (err) => finalize(() => reject(err)));
    child.on('exit', () => {
      finalize(() => {
        // Child writes a single line of JSON regardless of success.
        // If it's missing or malformed, treat it as a transport failure.
        const trimmed = stdout.trim();
        if (!trimmed) {
          reject(new Error('publish-aab child exited without writing a result'));
          return;
        }
        try {
          resolve(JSON.parse(trimmed) as ChildResult);
        } catch (parseErr) {
          reject(
            new Error(
              `publish-aab child wrote unparsable result: ${parseErr instanceof Error ? parseErr.message : 'unknown error'}; raw=${trimmed.slice(0, 500)}`
            )
          );
        }
      });
    });
    child.stdin?.write(JSON.stringify(input));
    child.stdin?.end();
  });
}

/**
 * Internal indirection so unit tests can stub the spawn-and-IPC layer
 * without monkey-patching `child_process`. Production code calls
 * `publishDeployedAiAuthoringBundles`, which calls `runPublishAabChild`,
 * which calls `runPublishAabChildImpl`. Tests reassign `runPublishAabChild`.
 */
export let runPublishAabChild = runPublishAabChildImpl;
export function setRunPublishAabChildForTesting(fn: typeof runPublishAabChildImpl | null): void {
  runPublishAabChild = fn ?? runPublishAabChildImpl;
}

export async function publishDeployedAiAuthoringBundles(
  deploymentId: string,
  fileResponses: Array<{ fullName: string; type: string; state: string }>,
  username: string,
  projectDir: string
): Promise<DeploymentWarning[]> {
  const bundleNames = Array.from(
    new Set(fileResponses.filter((f) => f.type === 'AiAuthoringBundle').map((f) => f.fullName))
  );
  if (bundleNames.length === 0) {
    return [];
  }

  const childPath = resolvePublishAabChildPath();
  const warnings: DeploymentWarning[] = [];

  for (const aabName of bundleNames) {
    let result: ChildResult;
    try {
      result = await runPublishAabChild(childPath, { username, projectDir, aabName });
    } catch (err) {
      const warning: DeploymentWarning = {
        stage: 'agent-publish',
        errorMessage: `Failed to run publish-aab child for '${aabName}': ${err instanceof Error ? err.message : 'unknown error'}`,
      };
      warnings.push(warning);
      addWarningEvent(deploymentId, warning);
      continue;
    }

    if (result.ok) {
      logger.info(
        {
          deploymentId,
          aabName,
          botId: result.botId,
          botVersionId: result.botVersionId,
          botVersionStatus: result.botVersionStatus,
        },
        'Published + activated AiAuthoringBundle'
      );
      continue;
    }

    const stage = result.stage === 'agent-activate' ? 'agent-activate' : 'agent-publish';
    const warning: DeploymentWarning = { stage, errorMessage: result.errorMessage };
    warnings.push(warning);
    addWarningEvent(deploymentId, warning);
  }
  return warnings;
}

/**
 * Build a Salesforce connection from resolved auth.
 *
 * Proactively refreshes the access token before returning.
 * `AuthInfo.create({ username })` reads whatever access token is stored
 * in the SFDX keychain — which may already be expired. Forcing a
 * refresh up front turns stale-token failures into one clean synchronous
 * error (caught by the caller as 502 Deployment Failed) instead of a
 * fuzzy mid-deploy 401 that SDR's auto-retry *usually* hides but can
 * confuse when combined with unrelated failures. Mirrors the pattern
 * in sfdx-agent-sdk's SfCoreOrgAuthResolver.resolve.
 *
 * `refreshAuth` is called defensively — test mocks of @salesforce/core's
 * Connection don't always implement it, and we don't want to force
 * every existing mock boundary to expand. If the method is missing we
 * skip it; real @salesforce/core Connection instances always have it.
 */
export async function buildConnectionFromAuth(auth: ResolvedAuth): Promise<Connection> {
  const authInfo = await AuthInfo.create({ username: auth.username });
  const conn = await Connection.create({ authInfo });
  if (typeof (conn as { refreshAuth?: () => Promise<void> }).refreshAuth === 'function') {
    await conn.refreshAuth();
  }
  return conn;
}

/**
 * Build a ComponentSet from the real metadata files on disk.
 * Reads package directories from sfdx-project.json instead of hardcoding paths.
 */
export async function buildComponentSet(projectDir: string): Promise<ComponentSet> {
  const configPath = path.join(projectDir, 'sfdx-project.json');
  const raw = await fs.readFile(configPath, 'utf-8');
  const config = JSON.parse(raw) as { packageDirectories: Array<{ path: string }> };
  if (!config.packageDirectories?.length) {
    throw new Error('sfdx-project.json must contain at least one packageDirectory');
  }
  const fsPaths = config.packageDirectories.map((d) => path.join(projectDir, d.path));
  logger.info({ fsPaths }, 'Building ComponentSet from source paths');
  return ComponentSet.fromSource({ fsPaths });
}

/**
 * Read the project's declared deploy stages, if any.
 *
 * Templates MAY declare `deployStages` in their `template.json` to run
 * multiple manifest-based deploys in order (e.g. schema → flows →
 * bundles). If `template.json` doesn't exist, returns `undefined` and
 * the caller falls back to the legacy single-pass
 * `ComponentSet.fromSource(force-app)` deploy.
 *
 * If `template.json` exists but is malformed (bad JSON, wrong shape,
 * bad stage fields), we throw `BuildError` rather than silently
 * falling through — a typo'd `deployStages` key would otherwise deploy
 * the wrong thing against a live org with no warning.
 *
 * Each stage's `manifest` path must be non-empty, a string, and must
 * not escape `projectDir` (path-traversal guard — the extracted
 * template zip is untrusted content).
 */
export async function readDeployStages(projectDir: string): Promise<DeployStage[] | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(projectDir, 'template.json'), 'utf-8');
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new BuildError(
      `Invalid template.json: ${err instanceof Error ? err.message : 'parse error'}`
    );
  }

  if (!isRecord(parsed) || !('deployStages' in parsed)) {
    return undefined;
  }

  const stages = parsed.deployStages;
  if (!Array.isArray(stages)) {
    throw new BuildError('template.json: deployStages must be an array');
  }
  if (stages.length === 0) {
    return undefined;
  }

  const projectRoot = path.resolve(projectDir);
  const validated: DeployStage[] = [];
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    if (!isRecord(stage)) {
      throw new BuildError(`template.json: deployStages[${i}] must be an object`);
    }
    if (typeof stage.manifest !== 'string' || stage.manifest.length === 0) {
      throw new BuildError(`template.json: deployStages[${i}].manifest must be a non-empty string`);
    }
    const resolved = path.resolve(projectRoot, stage.manifest);
    if (resolved !== projectRoot && !resolved.startsWith(projectRoot + path.sep)) {
      throw new BuildError(
        `template.json: deployStages[${i}].manifest escapes project root: ${stage.manifest}`
      );
    }
    const normalized: DeployStage = { manifest: stage.manifest };
    if (typeof stage.optional === 'boolean') normalized.optional = stage.optional;
    validated.push(normalized);
  }
  return validated;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Run a single ComponentSet deploy and return both the SDR response and
 * the extracted file responses. Shared by single-pass and staged deploys.
 */
async function runOneDeploy(
  deploymentId: string,
  components: ComponentSet,
  connection: Connection
): Promise<{
  status: string;
  numberComponentsDeployed: number;
  numberComponentsTotal: number;
  errorMessage?: string;
  fileResponses: Array<{ fullName: string; type: string; state: string }>;
}> {
  const deploy = await components.deploy({
    usernameOrConnection: connection,
    apiOptions: {
      rollbackOnError: true,
      testLevel: 'NoTestRun',
      rest: false,
    },
  });

  /* v8 ignore next 3 -- only fires during real SDR polling, not mocked tests */
  deploy.onUpdate((statusUpdate: Record<string, unknown>) => {
    addProgressEvent(deploymentId, mapStatusToProgressEvent(deploymentId, statusUpdate));
  });

  // 60-minute polling budget (3600 × 1s) — caps runaway Metadata API waits.
  const result = await deploy.pollStatus(undefined, 3600);
  return {
    status: result.response.status,
    numberComponentsDeployed: result.response.numberComponentsDeployed,
    numberComponentsTotal: result.response.numberComponentsTotal,
    errorMessage: result.response.errorMessage,
    fileResponses: result.getFileResponses(),
  };
}

/**
 * Run a multi-manifest staged deploy.
 *
 * For each declared stage we build a ComponentSet from its manifest XML
 * and run it against Salesforce sequentially. Required-stage failures
 * abort the remaining stages; optional-stage failures emit a warning
 * SSE event and continue.
 *
 * The React/Vite build runs once up front (if the project has React
 * sources) so any UIBundle-bearing stage ships the latest built assets.
 * Vite is a no-op when there are no .tsx/.jsx files.
 *
 * Aggregated result shape:
 *   status = 'Failed'                 — any required stage failed
 *   status = 'SucceededWithWarnings' — all required stages succeeded,
 *                                       at least one optional failed
 *   status = 'Succeeded'              — every stage succeeded
 *   numberComponents* are summed across all attempted stages.
 *   appUrl is set from the LAST stage that surfaced a UIBundle.
 */
async function runStagedDeploy(
  deploymentId: string,
  projectDir: string,
  stages: DeployStage[],
  connection: Connection,
  orgUsername: string
): Promise<void> {
  if (await hasReactFiles(projectDir)) {
    await runViteBuild(projectDir, orgUsername);
  }

  const stageSummaries: DeploymentStageSummary[] = [];
  const warnings: DeploymentWarning[] = [];
  const allFileResponses: Array<{ fullName: string; type: string; state: string }> = [];
  let numberComponentsDeployed = 0;
  let numberComponentsTotal = 0;
  let failedRequiredStage: string | undefined;

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    // Emit a stage event before each stage so clients can show progress.
    addStageEvent(deploymentId, {
      deploymentId,
      name: stage.manifest,
      index: i,
      total: stages.length,
    });

    // Build the ComponentSet from the manifest XML on disk. ComponentSet
    // resolves manifest paths relative to the sfdx-project package dirs,
    // so we pass an absolute path to avoid ambiguity.
    const manifestPath = path.join(projectDir, stage.manifest);
    const components = await ComponentSet.fromManifest({
      manifestPath,
      resolveSourcePaths: [projectDir],
    });

    const runResult = await runOneDeploy(deploymentId, components, connection);

    const summary: DeploymentStageSummary = {
      name: stage.manifest,
      status: runResult.status,
      numberComponentsDeployed: runResult.numberComponentsDeployed,
      numberComponentsTotal: runResult.numberComponentsTotal,
    };
    if (runResult.errorMessage) summary.errorMessage = runResult.errorMessage;
    stageSummaries.push(summary);

    numberComponentsDeployed += runResult.numberComponentsDeployed ?? 0;
    numberComponentsTotal += runResult.numberComponentsTotal ?? 0;
    for (const f of runResult.fileResponses) {
      allFileResponses.push(f);
    }

    const stageFailed = runResult.status !== 'Succeeded';
    if (stageFailed) {
      if (stage.optional) {
        // Optional stage failed — emit a warning and continue.
        const warning: DeploymentWarning = {
          stage: stage.manifest,
          errorMessage: runResult.errorMessage ?? `Stage '${stage.manifest}' failed`,
        };
        warnings.push(warning);
        addWarningEvent(deploymentId, warning);
      } else {
        // Required stage failed — abort remaining stages.
        failedRequiredStage = stage.manifest;
        break;
      }
    }
  }

  if (!failedRequiredStage) {
    try {
      const psWarnings = await assignDeployedPermissionSets(
        deploymentId,
        allFileResponses,
        connection
      );
      warnings.push(...psWarnings);
    } catch (err) {
      const warning: DeploymentWarning = {
        stage: 'permset-assignment',
        errorMessage: `PermissionSet auto-assignment failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      };
      warnings.push(warning);
      addWarningEvent(deploymentId, warning);
    }

    try {
      const aabWarnings = await publishDeployedAiAuthoringBundles(
        deploymentId,
        allFileResponses,
        orgUsername,
        projectDir
      );
      warnings.push(...aabWarnings);
    } catch (err) {
      const warning: DeploymentWarning = {
        stage: 'agent-publish',
        errorMessage: `AiAuthoringBundle publish/activate failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      };
      warnings.push(warning);
      addWarningEvent(deploymentId, warning);
    }
  }

  let aggregateStatus: string;
  if (failedRequiredStage) {
    aggregateStatus = 'Failed';
  } else if (warnings.length > 0) {
    aggregateStatus = 'SucceededWithWarnings';
  } else {
    aggregateStatus = 'Succeeded';
  }

  const deploymentResult: DeploymentResult = {
    deploymentId,
    status: aggregateStatus,
    numberComponentsDeployed,
    numberComponentsTotal,
    components: allFileResponses.map((f) => ({
      fullName: f.fullName,
      type: f.type,
      state: f.state,
    })),
    stages: stageSummaries,
  };

  if (warnings.length > 0) {
    deploymentResult.warnings = warnings;
  }
  if (failedRequiredStage) {
    deploymentResult.failedStage = failedRequiredStage;
  }

  // appUrl comes from the LAST stage that surfaced a UIBundle —
  // a later stage's bundle supersedes an earlier one. Skip on failure
  // so partially-deployed apps don't get a misleading URL.
  if (aggregateStatus !== 'Failed') {
    const uiBundle = [...allFileResponses].reverse().find((f) => f.type === 'UIBundle');
    if (uiBundle) {
      const instanceUrl = connection.getAuthInfoFields().instanceUrl;
      if (instanceUrl) {
        const appHost = toAppDomainUrl(instanceUrl) ?? instanceUrl;
        deploymentResult.appUrl = `${appHost}/lwr/application/ai/c-${uiBundle.fullName}`;
      }
    }
  }

  logger.info({ deploymentId, status: aggregateStatus }, 'Staged deployment completed');
  setDeploymentResult(deploymentId, deploymentResult);
}

/**
 * Start an async deployment and store the result when complete.
 * This function runs the deployment in the background without blocking.
 * Does not throw errors; stores all results (success and failure) in the deployment store.
 *
 * Deployment lifecycle:
 * 1. Connection is built and validated against Salesforce org
 * 2. If the project's template.json declares `deployStages`, run each
 *    manifest-based deploy in order (staged mode); otherwise build a
 *    ComponentSet from `force-app` sources and run a single deploy.
 * 3. Stage/progress/warning events are recorded as the deploy runs.
 * 4. Final result is stored in the deployment store (success or error).
 *
 * Connection is built twice: once for validation in the POST handler,
 * and again here for the actual deployment. This ensures early error reporting
 * while keeping the async background work isolated and retryable.
 */
export async function deployMetadataAsync(
  deploymentId: string,
  projectDir: string,
  auth: ResolvedAuth
): Promise<void> {
  try {
    logger.info({ deploymentId, projectDir }, 'Starting async deployment');

    const connection = await buildConnectionFromAuth(auth);

    // Staged-deploy branch: if the project's template.json declares
    // `deployStages`, dispatch each manifest deploy in sequence.
    const stages = await readDeployStages(projectDir);
    if (stages) {
      await runStagedDeploy(deploymentId, projectDir, stages, connection, auth.username);
      return;
    }

    // Legacy single-pass deploy: build React project if present, then
    // run one ComponentSet.fromSource() deploy over `force-app`.
    if (await hasReactFiles(projectDir)) {
      await runViteBuild(projectDir, auth.username);
    }

    const components = await buildComponentSet(projectDir);
    const runResult = await runOneDeploy(deploymentId, components, connection);

    const deploymentResult: DeploymentResult = {
      deploymentId,
      status: runResult.status,
      numberComponentsDeployed: runResult.numberComponentsDeployed,
      numberComponentsTotal: runResult.numberComponentsTotal,
      components: runResult.fileResponses.map((f) => ({
        fullName: f.fullName,
        type: f.type,
        state: f.state,
      })),
    };

    /* v8 ignore next 3 -- only set when Salesforce returns an error message */
    if (runResult.errorMessage) {
      deploymentResult.errorMessage = runResult.errorMessage;
    }

    // appUrl is surfaced only on success — a Failed single-pass deploy
    // must not yield a misleading webapp URL.
    if (runResult.status === 'Succeeded') {
      const uiBundle = runResult.fileResponses.find((f) => f.type === 'UIBundle');
      if (uiBundle) {
        const instanceUrl = connection.getAuthInfoFields().instanceUrl;
        if (instanceUrl) {
          const appHost = toAppDomainUrl(instanceUrl) ?? instanceUrl;
          deploymentResult.appUrl = `${appHost}/lwr/application/ai/c-${uiBundle.fullName}`;
        }
      }

      const postDeployWarnings: DeploymentWarning[] = [];
      try {
        const psWarnings = await assignDeployedPermissionSets(
          deploymentId,
          runResult.fileResponses,
          connection
        );
        postDeployWarnings.push(...psWarnings);
      } catch (err) {
        const warning: DeploymentWarning = {
          stage: 'permset-assignment',
          errorMessage: `PermissionSet auto-assignment failed: ${err instanceof Error ? err.message : 'unknown error'}`,
        };
        addWarningEvent(deploymentId, warning);
        postDeployWarnings.push(warning);
      }

      try {
        const aabWarnings = await publishDeployedAiAuthoringBundles(
          deploymentId,
          runResult.fileResponses,
          auth.username,
          projectDir
        );
        postDeployWarnings.push(...aabWarnings);
      } catch (err) {
        const warning: DeploymentWarning = {
          stage: 'agent-publish',
          errorMessage: `AiAuthoringBundle publish/activate failed: ${err instanceof Error ? err.message : 'unknown error'}`,
        };
        addWarningEvent(deploymentId, warning);
        postDeployWarnings.push(warning);
      }

      if (postDeployWarnings.length > 0) {
        deploymentResult.status = 'SucceededWithWarnings';
        deploymentResult.warnings = postDeployWarnings;
      }
    }

    logger.info({ deploymentId, status: runResult.status }, 'Async deployment completed');
    setDeploymentResult(deploymentId, deploymentResult);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Deployment failed';
    logger.error({ deploymentId, err }, 'Async deployment failed');
    setDeploymentError(deploymentId, msg);
  }
}

/**
 * Map an SDR status update into a ProgressEvent.
 * Extracted as a pure function for testability.
 */
export function mapStatusToProgressEvent(
  deploymentId: string,
  statusUpdate: Record<string, unknown>
): ProgressEvent {
  const getFileResponses = statusUpdate.getFileResponses as
    | (() => Array<{ fullName: string; type: string; state: string }>)
    | undefined;
  const components: DeploymentComponentResult[] = (getFileResponses?.() || []).map((f) => ({
    fullName: f.fullName,
    type: f.type,
    state: f.state,
  }));

  return {
    deploymentId,
    timestamp: new Date().toISOString(),
    status: (statusUpdate.status as string) || 'InProgress',
    numberComponentsDeployed: (statusUpdate.numberComponentsDeployed as number) || 0,
    numberComponentsTotal: (statusUpdate.numberComponentsTotal as number) || 0,
    components,
  };
}
