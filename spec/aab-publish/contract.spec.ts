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
 * SPEC TESTS — Human-guarded contract
 *
 * Contract for the **post-deploy AiAuthoringBundle publish + activate hook**
 * layered on top of `POST /v1/projects/:id/deployments`. When a deploy
 * succeeds and its `componentSuccesses` include one or more `AiAuthoringBundle`
 * components, the service must publish + activate each bundle against the
 * org so the runtime `BotDefinition` / `BotVersion` materialize.
 *
 * Why this contract exists: deploying an `AiAuthoringBundle` ships only the
 * authoring metadata (`.agent` script + `bundle-meta.xml`). The runtime
 * `BotDefinition` row that the agent invocable resolver looks up does NOT
 * materialize until an explicit Connect API publish call runs. Until that
 * call lands, the deployed agent is not invocable (chat panel returns
 * "agent not found"). This spec pins the observable behavior of the hook
 * that closes that gap automatically as part of every deploy.
 *
 * The spec is intentionally agnostic about HOW the hook executes the
 * publish + activate (subprocess, in-process library call, CLI shell-out).
 * It pins only the observable outputs: SSE warning events on failure,
 * deploy-status downgrade on failure, no-op when no AAB present, and the
 * final `complete` event shape.
 *
 * Auth for these tests is resolved via the zero-auth contract: the body
 * carries `{ orgAlias: 'test-alias' }` and `StateAggregator` is mocked to
 * resolve that alias to a test username.
 *
 * Mock boundary: @salesforce/core (auth requires network/keychain), the
 * SDR pollStatus call (deploy outcome), and the publish-aab child
 * spawn (so the contract can simulate publish/activate outcomes without
 * running the real `@salesforce/agents` library).
 *
 * Real: Fastify, filesystem, deployment store, SSE event stream wiring.
 *
 * These tests are the source of truth for the publish-hook contract. The
 * AI implementation agent must NOT modify this file.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import request from 'supertest';

// Mock @salesforce/core (auth requires network / real keychain). Pattern
// mirrors spec/deploy/contract.spec.ts so we can reuse fixtures from there.
const { mockConnectionCreate, mockAuthInfoCreate, mockResolveAlias } = vi.hoisted(() => ({
  mockConnectionCreate: vi.fn(),
  mockAuthInfoCreate: vi.fn(),
  mockResolveAlias: vi.fn(),
}));

vi.mock('@salesforce/core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@salesforce/core')>();
  return {
    ...original,
    Connection: { ...original.Connection, create: mockConnectionCreate },
    AuthInfo: { ...original.AuthInfo, create: mockAuthInfoCreate },
  };
});

vi.mock('../../src/domain/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/domain/auth.js')>();
  return {
    ...original,
    resolveAlias: mockResolveAlias,
  };
});

import { createApp } from '../../src/app.js';
import {
  COMPONENT_RESPONSES,
  setupTempProject,
  cleanupTempProject,
  setupDefaultMocks,
  setupDeployMock,
  setupStagedTemplateProject,
  cleanupStagedTemplateProject,
  setupHermeticHome,
  cleanupHermeticHome,
  TEST_INSTANCE_URL,
} from '../deploy/fixtures.js';
import { setRunPublishAabChildForTesting } from '../../src/domain/deploy.js';

const TEST_ORG_ALIAS = 'test-alias';
const TEST_USERNAME = 'user@test.example.com';

/**
 * Componentlist that includes an AiAuthoringBundle alongside the standard
 * UIBundle + custom-object responses. Used by the AAB-positive test cases.
 */
const COMPONENT_RESPONSES_WITH_AAB = [
  ...COMPONENT_RESPONSES,
  { fullName: 'TestAgent', type: 'AiAuthoringBundle', state: 'Created' },
];

/**
 * Build a successful deploy response whose getFileResponses returns the
 * supplied component list. Keeps each test's expected componentSuccesses
 * explicit and self-contained.
 */
function deployResponseWithComponents(
  components: Array<{ fullName: string; type: string; state: string }>
): {
  response: { status: string; numberComponentsDeployed: number; numberComponentsTotal: number };
  getFileResponses: () => Array<{ fullName: string; type: string; state: string }>;
} {
  return {
    response: {
      status: 'Succeeded',
      numberComponentsDeployed: components.length,
      numberComponentsTotal: components.length,
    },
    getFileResponses: () => components,
  };
}

/**
 * Stream the SSE events for a deployment until the `complete` event lands,
 * then return a structured snapshot of the events that arrived. Mirrors
 * the helper used by spec/deploy — duplicated here rather than exported
 * because the deploy fixtures don't surface it.
 */
async function streamUntilComplete(
  app: ReturnType<typeof createApp>,
  url: string
): Promise<{
  warnings: Array<{ stage: string; errorMessage: string }>;
  complete: Record<string, unknown>;
}> {
  const res = await request(app.server).get(url).set('Accept', 'text/event-stream');
  const text = res.text;
  const warnings: Array<{ stage: string; errorMessage: string }> = [];
  let complete: Record<string, unknown> = {};
  // Each SSE record is `event: NAME\n` followed by `data: JSON\n\n`.
  const records = text.split('\n\n').filter(Boolean);
  for (const record of records) {
    const lines = record.split('\n');
    const eventLine = lines.find((l) => l.startsWith('event:'));
    const dataLine = lines.find((l) => l.startsWith('data:'));
    if (!eventLine || !dataLine) continue;
    const eventName = eventLine.slice('event:'.length).trim();
    const dataJson = dataLine.slice('data:'.length).trim();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(dataJson) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (eventName === 'warning') {
      warnings.push(parsed as { stage: string; errorMessage: string });
    } else if (eventName === 'complete') {
      complete = parsed;
    }
  }
  return { warnings, complete };
}

describe('POST /v1/projects/:id/deployments — AiAuthoringBundle publish hook', () => {
  let app: ReturnType<typeof createApp>;
  let tmpDir: string;
  let projectId: string;
  let hermeticHome: string;
  const mockPollStatus = vi.fn();
  const mockChild = vi.fn();

  beforeAll(async () => {
    hermeticHome = await setupHermeticHome();
    const setup = await setupTempProject();
    tmpDir = setup.tmpDir;
    projectId = setup.projectId;
  });

  afterAll(async () => {
    await cleanupTempProject(tmpDir);
    await cleanupHermeticHome(hermeticHome);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    app = createApp();
    await app.ready();
    setupDefaultMocks(mockConnectionCreate, mockAuthInfoCreate);
    setupDeployMock(mockPollStatus);
    mockResolveAlias.mockImplementation((alias: string) =>
      alias === TEST_ORG_ALIAS ? TEST_USERNAME : undefined
    );
    mockConnectionCreate.mockResolvedValue({
      refreshAuth: vi.fn().mockResolvedValue(undefined),
      getAuthInfoFields: () => ({ instanceUrl: TEST_INSTANCE_URL }),
    });
    setRunPublishAabChildForTesting(mockChild);
  });

  afterEach(async () => {
    await app.close();
    setRunPublishAabChildForTesting(null);
  });

  describe('publish + activate is invoked once per AiAuthoringBundle in componentSuccesses', () => {
    it('is not invoked when the deploy ships no AiAuthoringBundle components', async () => {
      mockPollStatus.mockResolvedValue(deployResponseWithComponents(COMPONENT_RESPONSES));

      const deployRes = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: TEST_ORG_ALIAS });
      const depId = deployRes.body.deploymentId;

      const { warnings, complete } = await streamUntilComplete(
        app,
        `/v1/projects/${projectId}/deployments/${depId}/events`
      );
      expect(mockChild).not.toHaveBeenCalled();
      expect(warnings).toEqual([]);
      expect(complete.status).toBe('Succeeded');
    });

    it('is invoked once with each bundle name when the deploy ships AAB components', async () => {
      mockPollStatus.mockResolvedValue(
        deployResponseWithComponents([
          ...COMPONENT_RESPONSES,
          { fullName: 'AgentA', type: 'AiAuthoringBundle', state: 'Created' },
          { fullName: 'AgentB', type: 'AiAuthoringBundle', state: 'Created' },
        ])
      );
      mockChild.mockResolvedValue({
        ok: true,
        botId: '0Xx00000000001',
        botVersionId: '0XV00000000001',
        botVersionStatus: 'Active',
      });

      const deployRes = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: TEST_ORG_ALIAS });
      const depId = deployRes.body.deploymentId;

      const { warnings } = await streamUntilComplete(
        app,
        `/v1/projects/${projectId}/deployments/${depId}/events`
      );
      expect(mockChild).toHaveBeenCalledTimes(2);
      expect(mockChild.mock.calls.map((c) => (c[1] as { aabName: string }).aabName).sort()).toEqual(
        ['AgentA', 'AgentB']
      );
      expect(warnings).toEqual([]);
    });

    it('deduplicates repeated bundle names in componentSuccesses before invoking', async () => {
      // Staged deploys can surface the same component multiple times in
      // their aggregated fileResponses (one entry per stage that touched
      // it). The hook MUST collapse duplicates so each bundle is published
      // exactly once per deploy.
      mockPollStatus.mockResolvedValue(
        deployResponseWithComponents([
          ...COMPONENT_RESPONSES,
          { fullName: 'TestAgent', type: 'AiAuthoringBundle', state: 'Created' },
          { fullName: 'TestAgent', type: 'AiAuthoringBundle', state: 'Changed' },
        ])
      );
      mockChild.mockResolvedValue({
        ok: true,
        botId: '0Xx00000000001',
        botVersionId: '0XV00000000001',
        botVersionStatus: 'Active',
      });

      const deployRes = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: TEST_ORG_ALIAS });
      const depId = deployRes.body.deploymentId;

      await streamUntilComplete(app, `/v1/projects/${projectId}/deployments/${depId}/events`);
      expect(mockChild).toHaveBeenCalledTimes(1);
    });

    it('passes the deploying username and the project directory to the publish step', async () => {
      // The hook must hand the publish step enough context to (re)derive
      // an org Connection without going back to the keychain twice. The
      // deploying username (resolved through the zero-auth chain) and the
      // resolved project directory are the two values that pin the
      // publish to the same auth + DX project the deploy ran against.
      mockPollStatus.mockResolvedValue(deployResponseWithComponents(COMPONENT_RESPONSES_WITH_AAB));
      mockChild.mockResolvedValue({
        ok: true,
        botId: '0Xx00000000001',
        botVersionId: '0XV00000000001',
        botVersionStatus: 'Active',
      });

      const deployRes = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: TEST_ORG_ALIAS });
      const depId = deployRes.body.deploymentId;

      await streamUntilComplete(app, `/v1/projects/${projectId}/deployments/${depId}/events`);
      const [, input] = mockChild.mock.calls[0]!;
      expect(input).toMatchObject({
        username: TEST_USERNAME,
        aabName: 'TestAgent',
      });
      // Pin the exact path — the hook MUST resolve to <projectsRoot>/<projectId>,
      // not just any path containing the GUID. A loose `toContain(projectId)`
      // would pass for a sibling project under the same root.
      expect((input as { projectDir: string }).projectDir).toBe(path.join(tmpDir, projectId));
    });
  });

  describe('publish failures emit warning SSE events without failing the deploy', () => {
    it('emits an `agent-publish` warning when the publish step reports failure', async () => {
      mockPollStatus.mockResolvedValue(deployResponseWithComponents(COMPONENT_RESPONSES_WITH_AAB));
      mockChild.mockResolvedValue({
        ok: false,
        stage: 'agent-publish',
        errorMessage: "Failed to publish AiAuthoringBundle 'TestAgent': server returned 403",
      });

      const deployRes = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: TEST_ORG_ALIAS });
      const depId = deployRes.body.deploymentId;

      const { warnings, complete } = await streamUntilComplete(
        app,
        `/v1/projects/${projectId}/deployments/${depId}/events`
      );
      // Assert each substring independently — the contract is "the warning
      // references the affected bundle name AND the underlying error",
      // not "the implementation formats them in a specific order".
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.stage).toBe('agent-publish');
      expect(warnings[0]!.errorMessage).toEqual(expect.stringContaining('TestAgent'));
      expect(warnings[0]!.errorMessage).toEqual(expect.stringContaining('server returned 403'));
      // The deploy itself completed — the hook is best-effort. The
      // metadata has landed in the org and the user can recover via
      // `sf agent publish` / `sf agent activate` manually.
      expect(complete.status).toBe('SucceededWithWarnings');
    });

    it('emits an `agent-activate` warning when activate fails after a successful publish', async () => {
      mockPollStatus.mockResolvedValue(deployResponseWithComponents(COMPONENT_RESPONSES_WITH_AAB));
      mockChild.mockResolvedValue({
        ok: false,
        stage: 'agent-activate',
        errorMessage: "Failed to activate AiAuthoringBundle 'TestAgent': API_ERROR",
      });

      const deployRes = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: TEST_ORG_ALIAS });
      const depId = deployRes.body.deploymentId;

      const { warnings, complete } = await streamUntilComplete(
        app,
        `/v1/projects/${projectId}/deployments/${depId}/events`
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.stage).toBe('agent-activate');
      expect(warnings[0]!.errorMessage).toEqual(expect.stringContaining('TestAgent'));
      expect(warnings[0]!.errorMessage).toEqual(expect.stringContaining('API_ERROR'));
      expect(complete.status).toBe('SucceededWithWarnings');
    });

    it('emits an `agent-publish` warning when the publish step cannot be spawned at all', async () => {
      // Lower-level transport failures (the hook can't fork its child,
      // can't talk to the org, etc.) MUST be surfaced as a warning, not
      // an unhandled error that fails the deploy. Stage is collapsed to
      // `agent-publish` so SSE consumers only ever see the two stage
      // names defined in the contract.
      mockPollStatus.mockResolvedValue(deployResponseWithComponents(COMPONENT_RESPONSES_WITH_AAB));
      mockChild.mockRejectedValue(new Error('ENOENT: child entry not found'));

      const deployRes = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: TEST_ORG_ALIAS });
      const depId = deployRes.body.deploymentId;

      const { warnings, complete } = await streamUntilComplete(
        app,
        `/v1/projects/${projectId}/deployments/${depId}/events`
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.stage).toBe('agent-publish');
      expect(warnings[0]!.errorMessage).toEqual(expect.stringContaining('TestAgent'));
      expect(warnings[0]!.errorMessage).toEqual(expect.stringContaining('ENOENT'));
      expect(complete.status).toBe('SucceededWithWarnings');
    });

    it('processes every AAB even when an earlier one fails (no fail-fast within the hook)', async () => {
      // If AgentA fails publish, the hook must still attempt AgentB.
      // A cascading failure on the first bundle shouldn't strand the
      // others — each bundle is an independent unit of work.
      mockPollStatus.mockResolvedValue(
        deployResponseWithComponents([
          ...COMPONENT_RESPONSES,
          { fullName: 'AgentA', type: 'AiAuthoringBundle', state: 'Created' },
          { fullName: 'AgentB', type: 'AiAuthoringBundle', state: 'Created' },
        ])
      );
      mockChild.mockImplementation(async (_path: string, input: { aabName: string }) => {
        if (input.aabName === 'AgentA') {
          return {
            ok: false,
            stage: 'agent-publish',
            errorMessage: "Failed to publish AiAuthoringBundle 'AgentA': boom",
          };
        }
        return {
          ok: true,
          botId: 'botB',
          botVersionId: 'verB',
          botVersionStatus: 'Active',
        };
      });

      const deployRes = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: TEST_ORG_ALIAS });
      const depId = deployRes.body.deploymentId;

      const { warnings, complete } = await streamUntilComplete(
        app,
        `/v1/projects/${projectId}/deployments/${depId}/events`
      );
      expect(mockChild).toHaveBeenCalledTimes(2);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.errorMessage).toEqual(expect.stringContaining('AgentA'));
      expect(complete.status).toBe('SucceededWithWarnings');
    });
  });

  describe('publish hook does not fire on failed deploys', () => {
    it('skips the hook when the deploy itself failed, even if AAB components are listed', async () => {
      // When the deploy reports `Failed`, no publish should be attempted —
      // the bundle is not in the org, so there's nothing to publish. The
      // user gets the deploy-failure outcome, and no spurious agent-publish
      // warnings.
      mockPollStatus.mockResolvedValue({
        response: {
          status: 'Failed',
          numberComponentsDeployed: 0,
          numberComponentsTotal: 1,
        },
        getFileResponses: () => COMPONENT_RESPONSES_WITH_AAB,
      });

      const deployRes = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: TEST_ORG_ALIAS });
      const depId = deployRes.body.deploymentId;

      const { warnings, complete } = await streamUntilComplete(
        app,
        `/v1/projects/${projectId}/deployments/${depId}/events`
      );
      expect(mockChild).not.toHaveBeenCalled();
      expect(warnings).toEqual([]);
      expect(complete.status).toBe('Failed');
    });
  });

  describe('warnings combine cleanly with other post-deploy hooks', () => {
    it('preserves both permset-assignment and agent-publish warnings on the same deploy', async () => {
      // The deploy lifecycle runs multiple post-deploy hooks
      // (assignDeployedPermissionSets, publishDeployedAiAuthoringBundles).
      // When more than one hook emits a warning, BOTH must surface to
      // SSE consumers — the toast UI groups warnings by stage and a
      // refactor that swallowed one source would silently regress UX.
      // This test pins that the combined warning list preserves both
      // stage values and the bundle name.
      //
      // Trigger a permset-assignment warning by including a PermissionSet
      // in the deploy components AND making the deploying-user lookup
      // fail (the connection mock has no userId in authFields, and no
      // query() to fall back to). Trigger an agent-publish warning by
      // having the AAB child report failure.
      mockPollStatus.mockResolvedValue(
        deployResponseWithComponents([
          ...COMPONENT_RESPONSES,
          { fullName: 'Test_Permset', type: 'PermissionSet', state: 'Created' },
          { fullName: 'TestAgent', type: 'AiAuthoringBundle', state: 'Created' },
        ])
      );
      mockChild.mockResolvedValue({
        ok: false,
        stage: 'agent-publish',
        errorMessage: "Failed to publish AiAuthoringBundle 'TestAgent': boom",
      });

      const deployRes = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: TEST_ORG_ALIAS });
      const depId = deployRes.body.deploymentId;

      const { warnings, complete } = await streamUntilComplete(
        app,
        `/v1/projects/${projectId}/deployments/${depId}/events`
      );
      // Both warnings must surface — order is implementation-defined
      // (hooks run sequentially today), but the contract pins presence.
      const stages = warnings.map((w) => w.stage).sort();
      expect(stages).toEqual(['agent-publish', 'permset-assignment']);
      const aabWarning = warnings.find((w) => w.stage === 'agent-publish');
      expect(aabWarning?.errorMessage).toEqual(expect.stringContaining('TestAgent'));
      expect(complete.status).toBe('SucceededWithWarnings');
    });
  });
});

/**
 * Staged-deploy integration. Templates that declare `deployStages` in their
 * template.json (the load-bearing case for this PR — `data-curator` uses
 * staged deploy with a dedicated `manifest/authoring-bundle-package.xml`
 * stage) hit a different code path than the single-pass deploy fixture
 * above. The hook MUST integrate cleanly with the staged path: warnings
 * land on the same SSE stream, the `complete` event aggregates them
 * alongside any optional-stage warnings, and the per-stage `status`
 * values in `complete.stages[]` reflect the SDR outcomes (independent
 * of the hook's success/failure).
 */
describe('POST /v1/projects/:id/deployments — staged deploy + AAB integration', () => {
  let app: ReturnType<typeof createApp>;
  let tmpDir: string;
  let projectId: string;
  let hermeticHome: string;
  const mockPollStatus = vi.fn();
  const mockChild = vi.fn();

  beforeAll(async () => {
    hermeticHome = await setupHermeticHome();
    const setup = await setupStagedTemplateProject({
      stages: [
        { manifest: 'manifest/package.xml' },
        { manifest: 'manifest/authoring-bundle-package.xml' },
      ],
    });
    tmpDir = setup.tmpDir;
    projectId = setup.projectId;
  });

  afterAll(async () => {
    await cleanupStagedTemplateProject(tmpDir);
    await cleanupHermeticHome(hermeticHome);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    app = createApp();
    await app.ready();
    setupDeployMock(mockPollStatus);
    mockResolveAlias.mockImplementation((alias: string) =>
      alias === TEST_ORG_ALIAS ? TEST_USERNAME : undefined
    );
    mockAuthInfoCreate.mockResolvedValue({});
    mockConnectionCreate.mockResolvedValue({
      refreshAuth: vi.fn().mockResolvedValue(undefined),
      getAuthInfoFields: () => ({ instanceUrl: TEST_INSTANCE_URL }),
    });
    setRunPublishAabChildForTesting(mockChild);
  });

  afterEach(async () => {
    await app.close();
    setRunPublishAabChildForTesting(null);
  });

  it('publish hook fires when an AAB lands in a later stage of a staged deploy', async () => {
    // Stage 1 ships standard metadata; Stage 2 ships the AiAuthoringBundle.
    // The hook must inspect the *aggregated* fileResponses across all
    // stages and run publish for any AAB it finds, regardless of which
    // stage produced it.
    mockPollStatus
      .mockResolvedValueOnce(deployResponseWithComponents(COMPONENT_RESPONSES))
      .mockResolvedValueOnce(
        deployResponseWithComponents([
          { fullName: 'StagedAgent', type: 'AiAuthoringBundle', state: 'Created' },
        ])
      );
    mockChild.mockResolvedValue({
      ok: true,
      botId: '0Xx00000000099',
      botVersionId: '0XV00000000099',
      botVersionStatus: 'Active',
    });

    const deployRes = await request(app.server)
      .post(`/v1/projects/${projectId}/deployments`)
      .send({ orgAlias: TEST_ORG_ALIAS });
    const depId = deployRes.body.deploymentId;

    const { warnings, complete } = await streamUntilComplete(
      app,
      `/v1/projects/${projectId}/deployments/${depId}/events`
    );
    expect(mockChild).toHaveBeenCalledTimes(1);
    expect((mockChild.mock.calls[0]![1] as { aabName: string }).aabName).toBe('StagedAgent');
    expect(warnings).toEqual([]);
    expect(complete.status).toBe('Succeeded');
    // The staged-deploy `complete` event includes a `stages[]` summary;
    // the hook MUST NOT pollute that array — it stays SDR-only.
    expect(Array.isArray((complete as { stages: unknown[] }).stages)).toBe(true);
  });

  it('agent-publish warnings from a staged deploy surface in both the SSE stream and `complete.warnings[]`', async () => {
    // Failure case for the staged path: stage succeeds but the publish
    // step fails. The warning must land on the live SSE stream AND in
    // the aggregated `complete.warnings[]` array that staged deploys
    // emit (defined in spec/deploy/contract.md). Single-pass deploys do
    // not aggregate warnings into `complete`, so this assertion is
    // staged-specific.
    mockPollStatus
      .mockResolvedValueOnce(deployResponseWithComponents(COMPONENT_RESPONSES))
      .mockResolvedValueOnce(
        deployResponseWithComponents([
          { fullName: 'StagedAgent', type: 'AiAuthoringBundle', state: 'Created' },
        ])
      );
    mockChild.mockResolvedValue({
      ok: false,
      stage: 'agent-publish',
      errorMessage: "Failed to publish AiAuthoringBundle 'StagedAgent': server returned 503",
    });

    const deployRes = await request(app.server)
      .post(`/v1/projects/${projectId}/deployments`)
      .send({ orgAlias: TEST_ORG_ALIAS });
    const depId = deployRes.body.deploymentId;

    const { warnings, complete } = await streamUntilComplete(
      app,
      `/v1/projects/${projectId}/deployments/${depId}/events`
    );
    // Live SSE stream
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.stage).toBe('agent-publish');
    expect(warnings[0]!.errorMessage).toEqual(expect.stringContaining('StagedAgent'));
    expect(complete.status).toBe('SucceededWithWarnings');
    // Aggregated `complete.warnings[]` (staged-deploy contract)
    const completeWarnings = (
      complete as { warnings: Array<{ stage: string; errorMessage: string }> }
    ).warnings;
    expect(Array.isArray(completeWarnings)).toBe(true);
    expect(completeWarnings.some((w) => w.stage === 'agent-publish')).toBe(true);
    expect(completeWarnings.some((w) => w.errorMessage.includes('StagedAgent'))).toBe(true);
  });
});
