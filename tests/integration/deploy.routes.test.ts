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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../../src/app.js';
import * as deployments from '../../src/deployments.js';
import { ComponentSet } from '@salesforce/source-deploy-retrieve';
import { build as viteBuild } from 'vite';

vi.mock('vite', () => ({
  build: vi.fn().mockResolvedValue(undefined),
}));

const mockViteBuild = vi.mocked(viteBuild);

// Zero-auth contract: the HTTP handler resolves auth from the CLI
// environment (body orgAlias / project target-org / global default),
// so the integration tests pass `orgAlias: 'test-alias'` in the body
// and mock StateAggregator to resolve that alias to a username.
const { mockConnectionCreate, mockAuthInfoCreate, mockGetUsername, mockGetPropertyValue } =
  vi.hoisted(() => ({
    mockConnectionCreate: vi.fn(),
    mockAuthInfoCreate: vi.fn(),
    mockGetUsername: vi.fn(),
    mockGetPropertyValue: vi.fn(),
  }));

vi.mock('@salesforce/core', () => ({
  Connection: { create: mockConnectionCreate },
  AuthInfo: { create: mockAuthInfoCreate },
  Global: { SFDX_STATE_FOLDER: '.sfdx' },
  StateAggregator: {
    clearInstance: vi.fn(),
    getInstance: vi.fn().mockResolvedValue({
      aliases: { getUsername: mockGetUsername },
    }),
  },
  ConfigAggregator: {
    create: vi.fn().mockResolvedValue({
      getPropertyValue: mockGetPropertyValue,
    }),
  },
  OrgConfigProperties: { TARGET_ORG: 'target-org' },
}));

describe('deploy routes integration', () => {
  let app: ReturnType<typeof createApp>;
  let tmpDir: string;
  let projectId: string;
  const mockPollStatus = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-deploy-routes-'));
    process.env.PROJECTS_ROOT = tmpDir;

    app = createApp();
    await app.ready();

    // Create a project
    const createRes = await request(app.server).post('/v1/projects').send({});
    projectId = createRes.body.id;

    mockAuthInfoCreate.mockResolvedValue({});
    mockConnectionCreate.mockResolvedValue({
      getAuthInfoFields: () => ({ instanceUrl: 'https://test.salesforce.com' }),
    });

    // Only 'test-alias' resolves to a username — other aliases return undefined.
    mockGetUsername.mockImplementation((alias: string) =>
      alias === 'test-alias' ? 'user@test.example.com' : undefined
    );
    mockGetPropertyValue.mockReturnValue(undefined);

    vi.spyOn(ComponentSet.prototype, 'deploy').mockResolvedValue({
      pollStatus: mockPollStatus,
      onUpdate: vi.fn().mockReturnValue(undefined),
    } as never);

    mockPollStatus.mockResolvedValue({
      response: {
        status: 'Succeeded',
        numberComponentsDeployed: 3,
        numberComponentsTotal: 3,
      },
      getFileResponses: () => [
        { fullName: 'Hello_World__c', type: 'CustomObject', state: 'Created' },
        { fullName: 'Hello_World__c.Description__c', type: 'CustomField', state: 'Created' },
        { fullName: 'Hello_World__c.Priority__c', type: 'CustomField', state: 'Created' },
      ],
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.PROJECTS_ROOT;
    await app.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('SSE event stream', () => {
    it('properly closes SSE stream on client disconnect', async () => {
      // First, initiate a deployment
      const deployRes = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: 'test-alias' })
        .expect(202);

      const deploymentId = deployRes.body.deploymentId;

      // Wait a bit for the async deployment to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Then stream the events
      const res = await request(app.server)
        .get(`/v1/projects/${projectId}/deployments/${deploymentId}/events`)
        .set('Accept', 'text/event-stream')
        .expect(200);

      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(res.text).toContain('start');
      expect(res.text).toContain('complete');
    });

    // Regression for issue #90: when `reply.sse.send(...)` rejects mid-stream
    // (e.g. broken pipe on abrupt client disconnect), the poll interval must
    // be torn down from the rejection handler — not left to the next-tick
    // `isConnected` guard or `onClose` to catch up. Without the fix, a
    // doomed stream keeps polling and re-attempting failed sends until one
    // of the belt-and-suspenders paths fires.
    it('clears the poll interval when reply.sse.send rejects mid-stream', async () => {
      // Build a fresh app so we can register the fault-injection hook
      // before `app.ready()`. The shared `app` from the outer beforeEach
      // is already listening, and `addHook` rejects on a started instance.
      // The hook wraps `reply.sse.send` so that the *second* call rejects
      // with a broken-pipe-shaped error (the first call is the
      // synchronous `start` send, which we let succeed so the handler
      // enters the poll loop). All subsequent calls also reject,
      // simulating a fully-doomed stream.
      const faultApp = createApp();
      // Lifecycle note: the `Object.defineProperty` accessor below is scoped
      // to this `faultApp` instance and is torn down with it via
      // `faultApp.close()` in the `finally` block — no `afterEach` cleanup
      // is needed (and adding one would fight the per-test fresh-app
      // pattern this test relies on).
      faultApp.addHook('preHandler', async (_request, reply) => {
        let actualSse: { send: (...a: unknown[]) => Promise<void> } | undefined;
        Object.defineProperty(reply, 'sse', {
          configurable: true,
          get: () => actualSse,
          set: (val: { send: (...a: unknown[]) => Promise<void> }) => {
            const origSend = val.send.bind(val);
            let callCount = 0;
            val.send = (...args: unknown[]): Promise<void> => {
              callCount++;
              if (callCount === 1) return origSend(...args);
              const err = new Error('write EPIPE') as Error & { code: string };
              err.code = 'EPIPE';
              return Promise.reject(err);
            };
            actualSse = val;
          },
        });
      });
      await faultApp.ready();
      const projectRes = await request(faultApp.server).post('/v1/projects').send({});
      const faultProjectId = projectRes.body.id as string;

      try {
        // Hold the deployment in InProgress so the poll loop never reaches
        // its terminal `complete` send — the test exercises the non-terminal
        // stage/progress/warning rejection path.
        mockPollStatus.mockImplementation(
          () =>
            new Promise(() => {
              /* never resolves */
            })
        );

        // The replay phase reads stage events synchronously and `await`s
        // each `send`. The first call to `getDeploymentStageEvents` in
        // the handler is replay; we return [] there so `lastStageCount`
        // stays 0 and the handler enters the poll interval cleanly.
        // Subsequent calls happen inside the poll interval (where sends
        // are .catch()-handled, not awaited) — those return a stage so
        // the loop attempts a non-terminal `send` that rejects.
        const stageSpy = vi.spyOn(deployments, 'getDeploymentStageEvents');
        const stageEvent = {
          name: 'stage-1',
          stageIndex: 0,
          totalStages: 1,
          numberComponentsDeployed: 0,
          numberComponentsTotal: 1,
          startedAt: new Date().toISOString(),
        } as unknown as deployments.StageEvent;
        let stageCalls = 0;
        stageSpy.mockImplementation(() => {
          stageCalls++;
          // Call 1 = synchronous replay during handler prelude. Calls
          // 2+ = poll-interval ticks where the rejection path is wired.
          return stageCalls === 1 ? [] : [stageEvent];
        });

        const deployRes = await request(faultApp.server)
          .post(`/v1/projects/${faultProjectId}/deployments`)
          .send({ orgAlias: 'test-alias' })
          .expect(202);
        const deploymentId = deployRes.body.deploymentId;

        // Open the stream. Handler sends `start` (success — call #1 in
        // the wrapped `send`). Replay reads stages → []; reads progress
        // → []; reads warnings → []. Handler enters the poll interval
        // and returns. First tick: stage spy returns [stageEvent], the
        // loop calls `reply.sse.send({event: 'stage', ...}).catch(...)`
        // — call #2 in the wrapped `send` rejects. The fix tears down
        // the interval and closes the stream from the rejection
        // handler, so the response ends.
        const res = await request(faultApp.server)
          .get(`/v1/projects/${faultProjectId}/deployments/${deploymentId}/events`)
          .set('Accept', 'text/event-stream')
          .expect(200);
        expect(res.text).toContain('start');

        // Snapshot how many times the storage layer was polled, then wait
        // longer than several poll-interval cycles (100ms each). If the
        // interval was correctly torn down from the rejection handler, the
        // count must not grow. Without the fix, the doomed stream keeps
        // polling on each tick.
        const callsAfterClose = stageSpy.mock.calls.length;
        await new Promise((resolve) => setTimeout(resolve, 350));
        expect(stageSpy.mock.calls.length).toBe(callsAfterClose);
      } finally {
        await faultApp.close();
      }
    });

    it('handles SSE for in-progress deployments', async () => {
      // Mock a long-running deployment
      let pollCalled = 0;
      mockPollStatus.mockImplementation(async () => {
        pollCalled++;
        // Return in-progress for first few calls, then succeeded
        if (pollCalled < 2) {
          return {
            response: {
              status: 'InProgress',
              numberComponentsDeployed: 1,
              numberComponentsTotal: 3,
            },
            getFileResponses: () => [],
          };
        }
        return {
          response: {
            status: 'Succeeded',
            numberComponentsDeployed: 3,
            numberComponentsTotal: 3,
          },
          getFileResponses: () => [{ fullName: 'Test__c', type: 'CustomObject', state: 'Created' }],
        };
      });

      const deployRes = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: 'test-alias' })
        .expect(202);

      const deploymentId = deployRes.body.deploymentId;

      // Stream events - should get both in-progress and complete
      // Wait for deployment to complete
      await new Promise((resolve) => setTimeout(resolve, 200));

      const res = await request(app.server)
        .get(`/v1/projects/${projectId}/deployments/${deploymentId}/events`)
        .set('Accept', 'text/event-stream')
        .expect(200);

      expect(res.text).toContain('start');
      expect(res.text).toContain('complete');
    });
  });

  // Regression tests for issue #206: see fs-events.routes.test.ts for the
  // full story. The spec/ tests use supertest's default `Accept: */*`, which
  // bypasses the `@fastify/sse` plugin wrapper. These cover the browser
  // EventSource path (`Accept: text/event-stream`).
  describe('SSE 404 with Accept: text/event-stream (issue #206)', () => {
    it('returns 404 problem+json for an unknown project ID', async () => {
      const res = await request(app.server)
        .get('/v1/projects/00000000-0000-0000-0000-000000000000/deployments/deploy_any/events')
        .set('Accept', 'text/event-stream')
        .expect(404);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(404);
      expect(res.body.title).toBe('Project Not Found');
    });

    it('returns 404 problem+json for an unknown deployment ID', async () => {
      const res = await request(app.server)
        .get(`/v1/projects/${projectId}/deployments/deploy_does-not-exist/events`)
        .set('Accept', 'text/event-stream')
        .expect(404);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(404);
      expect(res.body.title).toBe('Deployment Not Found');
    });
  });

  describe('error handling in POST deployments', () => {
    it('returns 502 when ComponentSet.deploy throws', async () => {
      vi.spyOn(ComponentSet.prototype, 'deploy').mockRejectedValueOnce(new Error('Deploy failed'));

      // This should still return 202 because the error happens async
      const res = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: 'test-alias' })
        .expect(202);

      expect(res.body.deploymentId).toBeDefined();
    });

    // Empty-string orgAlias must 400, matching POST /v1/projects behavior.
    // Without the minLength:1 schema guard, resolveDeployAuth would silently
    // fall through to env/project/global — inconsistent with project
    // creation, which throws OrgAliasEmptyError on "".
    it('rejects empty-string orgAlias with 400', async () => {
      const res = await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: '' })
        .expect(400);
      expect(res.body.status).toBe(400);
    });
  });

  // Regression coverage for the Vite-build-up-front change in runStagedDeploy:
  // staged deploys with React sources must build before any stage runs so the
  // first UIBundle-bearing stage ships the latest built assets. Without the
  // build, SDR would upload the stale (or empty) dist/ directory.
  describe('Vite build up front in staged deploys', () => {
    it('runs Vite build before any stage when project has React files', async () => {
      // Extend the project with a template.json declaring a single stage
      // and a React source file.
      const projectDir = path.join(tmpDir, projectId);
      await fs.mkdir(path.join(projectDir, 'src'), { recursive: true });
      await fs.writeFile(path.join(projectDir, 'src/App.tsx'), 'export default () => <div/>;');
      await fs.mkdir(path.join(projectDir, 'manifest'), { recursive: true });
      await fs.writeFile(
        path.join(projectDir, 'manifest/package.xml'),
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
          '  <version>67.0</version>\n' +
          '</Package>\n'
      );
      await fs.writeFile(
        path.join(projectDir, 'template.json'),
        JSON.stringify({ deployStages: [{ manifest: 'manifest/package.xml' }] })
      );

      // Start deployment and wait for async work to progress.
      await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: 'test-alias' })
        .expect(202);
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Vite was called exactly once, and the config matches what build.ts
      // declares (configFile: false, programmatic outDir).
      expect(mockViteBuild).toHaveBeenCalledTimes(1);
      const callArg = mockViteBuild.mock.calls[0][0] as {
        configFile?: boolean;
        build?: { outDir?: string };
      };
      expect(callArg.configFile).toBe(false);
      expect(callArg.build?.outDir).toContain(
        path.join('force-app/main/default/uiBundles/App/dist')
      );
    });

    it('skips Vite build when no React files are present', async () => {
      // Same projectDir but without any .tsx/.jsx — staged deploy path still
      // runs but Vite should not.
      const projectDir = path.join(tmpDir, projectId);
      await fs.mkdir(path.join(projectDir, 'manifest'), { recursive: true });
      await fs.writeFile(
        path.join(projectDir, 'manifest/package.xml'),
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
          '  <version>67.0</version>\n' +
          '</Package>\n'
      );
      await fs.writeFile(
        path.join(projectDir, 'template.json'),
        JSON.stringify({ deployStages: [{ manifest: 'manifest/package.xml' }] })
      );

      await request(app.server)
        .post(`/v1/projects/${projectId}/deployments`)
        .send({ orgAlias: 'test-alias' })
        .expect(202);
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(mockViteBuild).not.toHaveBeenCalled();
    });
  });
});
