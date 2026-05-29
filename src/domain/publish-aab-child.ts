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
 * AiAuthoringBundle publish + activate, isolated in a child process.
 *
 * This file is forked by `publishDeployedAiAuthoringBundles` in
 * `deploy.ts`. It runs the `@salesforce/agents` `Agent.publish()` +
 * `Agent.activate()` calls in a separate Node process so that the
 * library's nock-imported global HTTP interceptor cannot pollute the
 * parent project-service's outbound HTTP traffic.
 *
 * ## Why a child process
 *
 * `@salesforce/agents@1.6.x` declares `nock` as a *runtime* dependency
 * (not devDependency). Importing the library transitively imports
 * `lib/maybe-mock.js`, which `require()`s `nock`, whose module-init
 * constructs a `BatchInterceptor` from `@mswjs/interceptors` and
 * monkey-patches `http.ClientRequest` and `http.request` globally —
 * see `node_modules/@mswjs/interceptors/lib/node/ClientRequest-*.cjs`
 * which `MockHttpSocket`-wraps every outgoing socket. The result: any
 * deploy in the same Node process that imports `@salesforce/agents`
 * sees its SOAP / metadata API calls fail with `read EINVAL` because
 * the mock socket aborts requests it doesn't have a matching scope for.
 *
 * Running publish + activate in a forked child contains the side effect:
 *   - The parent project-service stays clean for the metadata-deploy
 *     phase (which happens before this hook runs anyway).
 *   - The child's nock pollution dies with the process when this script
 *     exits.
 *   - The next deploy starts with a fresh parent process that hasn't
 *     touched `@salesforce/agents`.
 *
 * Once `@salesforce/agents` ships a fix that moves nock to
 * devDependencies (or excises `maybe-mock.js` from production code
 * paths), this file should be deleted and the publish + activate calls
 * inlined back into `publishDeployedAiAuthoringBundles`. The wrapper in
 * `deploy.ts` keeps the architectural seam minimal — only the actual
 * library invocation moved out, not the warning-aggregation logic.
 *
 * ## What the child needs from the parent
 *
 * The parent's `Connection` is built from `AuthInfo.create({ username })`,
 * which reads tokens from the SFDX keychain on disk (`~/.sf/`). The
 * child re-derives an equivalent Connection by calling the same
 * `AuthInfo.create` — no socket handshake, no token refresh dance,
 * just a file lookup. The parent passes:
 *
 *   - `username` (from ResolvedAuth) — used to build a fresh Connection
 *   - `projectDir`                   — used to resolve the SfProject
 *   - `aabName`                      — bundle developer name
 *
 * via stdin as a single JSON message. The child writes a JSON result
 * to stdout and exits with code 0 (success), 1 (caught error). The
 * parent maps non-zero exits to `agent-publish` warnings on the
 * deployment SSE stream, the same shape as if the in-process call had
 * thrown.
 *
 * ## Entry point
 *
 * The compiled output lives at `dist/domain/publish-aab-child.js`.
 * `publishDeployedAiAuthoringBundles` resolves that path via
 * `import.meta.url` and forks it with `child_process.fork`.
 *
 * ## Stdin protocol
 *
 * Single line of JSON:
 *
 *   { "username": "user@org.example", "projectDir": "/path/to/proj", "aabName": "DataCuratorAgent" }
 *
 * ## Stdout protocol
 *
 * On success, single JSON object:
 *
 *   { "ok": true, "botId": "0Xx...", "botVersionId": "0XV...",
 *     "botVersionStatus": "Active" }
 *
 * On failure, single JSON object:
 *
 *   { "ok": false, "stage": "agent-publish" | "agent-activate" | "agent-init",
 *     "errorMessage": "..." }
 *
 * The child never prints anything other than this single line on stdout —
 * pino logs from inside the library go to stderr and are surfaced via the
 * parent's pino pipeline.
 */

import path from 'node:path';
import { AuthInfo, Connection, SfProject } from '@salesforce/core';
import { Agent } from '@salesforce/agents';
import { findPackageDirContainingBundle } from './aab-locator.js';

interface ChildInput {
  username: string;
  projectDir: string;
  aabName: string;
}

type ChildResult =
  | {
      ok: true;
      botId: string;
      botVersionId: string;
      botVersionStatus: string;
    }
  | {
      ok: false;
      stage: 'agent-init' | 'agent-publish' | 'agent-activate' | 'sfproject-resolve' | 'connection';
      errorMessage: string;
    };

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}

function writeResult(result: ChildResult): void {
  process.stdout.write(JSON.stringify(result) + '\n');
}

async function run(): Promise<number> {
  let input: ChildInput;
  try {
    const raw = await readStdin();
    input = JSON.parse(raw) as ChildInput;
  } catch (err) {
    writeResult({
      ok: false,
      stage: 'agent-init',
      errorMessage: `Failed to parse child input: ${err instanceof Error ? err.message : 'unknown error'}`,
    });
    return 1;
  }

  let connection: Connection;
  try {
    const authInfo = await AuthInfo.create({ username: input.username });
    connection = await Connection.create({ authInfo });
    if (typeof (connection as { refreshAuth?: () => Promise<void> }).refreshAuth === 'function') {
      await connection.refreshAuth();
    }
  } catch (err) {
    writeResult({
      ok: false,
      stage: 'connection',
      errorMessage: `Failed to build Connection for '${input.username}': ${err instanceof Error ? err.message : 'unknown error'}`,
    });
    return 1;
  }

  let project: SfProject;
  try {
    project = await SfProject.resolve(input.projectDir);
  } catch (err) {
    writeResult({
      ok: false,
      stage: 'sfproject-resolve',
      errorMessage: `Could not resolve SfProject at '${input.projectDir}': ${err instanceof Error ? err.message : 'unknown error'}`,
    });
    return 1;
  }

  // Workaround for two bugs in @salesforce/agents@1.6.x's
  // `scriptAgentPublisher.validateDeveloperName()`:
  //
  // 1. It calls `path.resolve(this.project.getDefaultPackage().path)` without
  //    passing the project root as the first arg. `path` is the relative string
  //    from sfdx-project.json (e.g. "force-app"), so `path.resolve` joins it
  //    against `process.cwd()` instead of the project root.
  //
  // 2. It only searches the *default* package directory for the bundle. Templates
  //    that legitimately keep `aiAuthoringBundles/` under a non-default
  //    `packageDirectory` (e.g. data-curator's `agentforce-bundle/`) cannot be
  //    published without this workaround, even though the metadata-API deploy
  //    happily resolves bundles from any declared package dir.
  //
  // Walk every package directory looking for `aiAuthoringBundles/<aabName>/`,
  // then override `getDefaultPackage()` to return that directory's absolute
  // path. The library's `path.resolve(<absolute>)` becomes a no-op and the
  // recursive `findAuthoringBundle` lookup succeeds. If no package directory
  // contains the bundle, fall back to the original default's absolute path so
  // the library produces its normal "Cannot find an authoring bundle" error
  // (rather than us pre-empting it with a less informative message).
  //
  // Remove once @salesforce/agents (a) uses `project.getPath()` for the base
  // and (b) searches all package directories instead of only the default.
  const projectRoot = project.getPath();
  const packageDirsAbs = project
    .getPackageDirectories()
    .map((pkg) => pkg.fullPath ?? path.resolve(projectRoot, pkg.path));
  const containingPackage = findPackageDirContainingBundle(packageDirsAbs, input.aabName);
  const origGetDefaultPackage = project.getDefaultPackage.bind(project);
  project.getDefaultPackage = () => {
    const pkg = origGetDefaultPackage();
    const absolutePath =
      containingPackage ?? pkg.fullPath ?? path.resolve(input.projectDir, pkg.path);
    return { ...pkg, path: absolutePath };
  };

  let publishResult: { botId: string; botVersionId: string; developerName: string };
  try {
    const scriptAgent = await Agent.init({ connection, project, aabName: input.aabName });
    // skipMetadataRetrieve=true — don't mutate the local DX project on
    // every deploy. We only care about the org-side BotDefinition +
    // BotVersion, not pulling regenerated metadata back to disk.
    publishResult = await scriptAgent.publish(true);
  } catch (err) {
    writeResult({
      ok: false,
      stage: 'agent-publish',
      errorMessage: `Failed to publish AiAuthoringBundle '${input.aabName}': ${err instanceof Error ? err.message : 'unknown error'}`,
    });
    return 1;
  }

  try {
    const productionAgent = await Agent.init({
      connection,
      project,
      apiNameOrId: publishResult.botId,
    });
    const activated = await productionAgent.activate();
    writeResult({
      ok: true,
      botId: publishResult.botId,
      botVersionId: publishResult.botVersionId,
      botVersionStatus: activated.Status,
    });
    return 0;
  } catch (err) {
    writeResult({
      ok: false,
      stage: 'agent-activate',
      errorMessage: `Failed to activate AiAuthoringBundle '${input.aabName}': ${err instanceof Error ? err.message : 'unknown error'}`,
    });
    return 1;
  }
}

run().then(
  (code) => process.exit(code),
  (err) => {
    // Defensive: any uncaught throw in run() that wasn't translated to a
    // ChildResult lands here. Surface it as a generic agent-init failure
    // so the parent always gets a structured error instead of a crash.
    writeResult({
      ok: false,
      stage: 'agent-init',
      errorMessage: `Uncaught error in publish-aab child: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    });
    process.exit(1);
  }
);
