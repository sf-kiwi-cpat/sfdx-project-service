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
 * Tier 3 live deploy test — opt-in, targets a REAL Salesforce org.
 *
 * This is NOT part of the default `npm test` sweep. It runs only when
 * explicitly invoked via `npm run test:deploy:live` (see
 * `package.json`), and it will auto-skip with a helpful message if
 * the sf CLI has no resolvable target org.
 *
 * Auth chain (same as the production POST /deployments path):
 *   1. Body orgAlias (if provided — we don't set one; we use the default)
 *   2. SF_TARGET_ORG env var
 *   3. sf CLI global default target-org
 *
 * Org prerequisites the test does NOT attempt to validate up front
 * (the deploy itself will surface them):
 *   • Agentforce Vibe for Multi-Framework (Beta) must be enabled for
 *     UIBundle deploys. See docs/api.md.
 *
 * Cost profile: ~50s per template against a warm scratch org. We run
 * all templates under `templates/src/` sequentially; the overall
 * suite budget is `templates × 180s` with a 10-minute vitest timeout.
 *
 * Emits `tests/live/.last-run.json` on exit with per-template timings
 * so we can track performance drift between runs.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { ConfigAggregator, OrgConfigProperties } from '@salesforce/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const TEMPLATES_SRC = path.join(REPO_ROOT, 'templates/src');
const PORT = Number(process.env.TIER3_PORT ?? 3099);
const BASE_URL = `http://localhost:${PORT}`;

interface TemplateResult {
  template: string;
  status: 'skipped' | 'passed' | 'failed';
  elapsedMs: number;
  finalStatus?: string;
  numberComponentsDeployed?: number;
  numberComponentsTotal?: number;
  uiBundleDeployed?: boolean;
  appUrl?: string;
  warnings?: number;
  error?: string;
}

async function discoverTemplates(): Promise<string[]> {
  const entries = await fs.readdir(TEMPLATES_SRC, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

async function resolveDefaultOrg(): Promise<string | undefined> {
  // If the user set SF_TARGET_ORG, use it — else fall back to the sf
  // CLI's global default. This matches the service's real auth chain.
  if (process.env.SF_TARGET_ORG) return process.env.SF_TARGET_ORG;
  try {
    const cfg = await ConfigAggregator.create();
    const value = cfg.getPropertyValue(OrgConfigProperties.TARGET_ORG);
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

async function waitForHealth(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`${url}/health`, (res) => {
          if (res.statusCode === 200) {
            res.resume();
            resolve();
          } else {
            reject(new Error(`health returned ${res.statusCode}`));
          }
        });
        req.on('error', reject);
        req.setTimeout(1500, () => req.destroy(new Error('health timeout')));
      });
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`Service never became healthy: ${String(lastErr)}`);
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`POST ${url} → ${res.statusCode}: ${text}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            resolve(text);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function waitForDeploymentComplete(
  projectId: string,
  deploymentId: string,
  timeoutMs = 300_000
): Promise<{ status: string; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}/v1/projects/${projectId}/deployments/${deploymentId}/events`;
    const req = http.get(url, { headers: { Accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`SSE returned ${res.statusCode}`));
        return;
      }
      let buffer = '';
      let currentEvent = '';
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error(`deployment did not complete within ${timeoutMs}ms`));
      }, timeoutMs);

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');
        // SSE frames are delimited by blank lines.
        let frameEnd: number;
        while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, frameEnd);
          buffer = buffer.slice(frameEnd + 2);
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice('event: '.length).trim();
            } else if (line.startsWith('data: ') && currentEvent === 'complete') {
              clearTimeout(timer);
              req.destroy();
              try {
                const body = JSON.parse(line.slice('data: '.length)) as Record<string, unknown>;
                resolve({ status: String(body.status ?? 'Unknown'), body });
              } catch (err) {
                reject(err);
              }
              return;
            }
          }
        }
      });
      res.on('error', reject);
      res.on('close', () => {
        clearTimeout(timer);
      });
    });
    req.on('error', reject);
  });
}

describe('tier-3: live deploy of every template against the default org', async () => {
  const defaultOrg = await resolveDefaultOrg();
  const shouldSkip = !defaultOrg;
  const templates = shouldSkip ? [] : await discoverTemplates();

  if (shouldSkip) {
    console.log(
      '\n⚠  tests/live skipped: no default org.\n' +
        '   Log in once:   sf org login web --set-default\n' +
        '   Or target one: SF_TARGET_ORG=my-alias npm run test:deploy:live\n'
    );
  } else {
    console.log(
      `\n▸ tests/live targeting org: ${defaultOrg}\n  Found ${templates.length} template(s).\n`
    );
  }

  let server: ChildProcess | undefined;
  let tmpRoot: string;
  const results: TemplateResult[] = [];

  beforeAll(async () => {
    if (shouldSkip) return;

    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-tier3-'));

    // Spawn the built service so the deploys use the real (non-mocked)
    // SDR and @salesforce/core code paths end-to-end. Use `node dist/`
    // rather than `tsx watch` so the server is stable during deploys.
    server = spawn('node', [path.join(REPO_ROOT, 'dist/index.js')], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        PROJECTS_ROOT: tmpRoot,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.on('data', (c: Buffer) => {
      process.stdout.write(`[service] ${c.toString()}`);
    });
    server.stderr?.on('data', (c: Buffer) => {
      process.stderr.write(`[service] ${c.toString()}`);
    });

    await waitForHealth(BASE_URL);
  }, 60_000);

  afterAll(async () => {
    if (server) {
      server.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
      if (!server.killed) server.kill('SIGKILL');
    }
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
    if (results.length > 0) {
      const outFile = path.join(__dirname, '.last-run.json');
      await fs.writeFile(
        outFile,
        JSON.stringify({ org: defaultOrg, ranAt: new Date().toISOString(), results }, null, 2)
      );
      console.log(`\n▸ Wrote timings to ${outFile}\n`);
    }
  });

  it.skipIf(shouldSkip)('resolves a default org from the sf CLI', () => {
    expect(defaultOrg).toBeDefined();
  });

  describe.skipIf(shouldSkip).each(templates)('%s', (templateId) => {
    it('deploys cleanly and surfaces a UIBundle appUrl', async () => {
      const t0 = Date.now();
      const result: TemplateResult = {
        template: templateId,
        status: 'failed',
        elapsedMs: 0,
      };
      results.push(result);

      try {
        const createRes = (await postJson(`${BASE_URL}/v1/projects`, {
          template: templateId,
        })) as { id: string };
        const projectId = createRes.id;

        const deployRes = (await postJson(
          `${BASE_URL}/v1/projects/${projectId}/deployments`,
          {}
        )) as { deploymentId: string };
        const deploymentId = deployRes.deploymentId;

        const { status: finalStatus, body } = await waitForDeploymentComplete(
          projectId,
          deploymentId,
          300_000
        );

        result.elapsedMs = Date.now() - t0;
        result.finalStatus = finalStatus;
        result.numberComponentsDeployed = body.numberComponentsDeployed as number;
        result.numberComponentsTotal = body.numberComponentsTotal as number;
        result.appUrl = body.appUrl as string | undefined;
        const warnings = (body.warnings as unknown[] | undefined) ?? [];
        result.warnings = warnings.length;
        const components = (body.components as Array<{ type: string }> | undefined) ?? [];
        result.uiBundleDeployed = components.some((c) => c.type === 'UIBundle');

        // The deploy must end in Succeeded or SucceededWithWarnings
        // — a Failed overall status means a required stage broke.
        expect(
          ['Succeeded', 'SucceededWithWarnings'],
          `final status was ${finalStatus}; expected Succeeded*`
        ).toContain(finalStatus);

        // A UIBundle must have shipped (every built-in template
        // has one). Catches "deploy succeeded but UIBundle was
        // silently skipped" regressions.
        expect(result.uiBundleDeployed, 'UIBundle component must be in deployed set').toBe(true);

        // appUrl is only populated when a UIBundle was deployed
        // into the Succeeded* path — it's the user-visible link.
        expect(result.appUrl, 'appUrl must be populated for UIBundle deploys').toMatch(
          /\/lwr\/application\/ai\/c-/
        );

        // Performance budget — matches the 48s we saw on QA; 180s
        // accommodates a cold sfdx-project load + slower Flow
        // activations.
        expect(
          result.elapsedMs,
          `deploy took ${result.elapsedMs}ms (budget: 180_000ms)`
        ).toBeLessThan(180_000);

        result.status = 'passed';
      } catch (err) {
        result.elapsedMs = Date.now() - t0;
        result.error = err instanceof Error ? err.message : String(err);
        throw err;
      }
    }, // to start the SDR poll before the SSE wait's inner timeout. // Vitest per-test timeout. 300s leaves budget for the service
    360_000);
  });
});
