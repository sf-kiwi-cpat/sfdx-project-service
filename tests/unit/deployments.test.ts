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

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createDeployment,
  deploymentExists,
  getDeploymentResult,
  setDeploymentResult,
  setDeploymentError,
  getDeployment,
  getDeploymentPollPromise,
  setDeploymentPollPromise,
  addProgressEvent,
  getProgressEvents,
  addStageEvent,
  getDeploymentStageEvents,
  addWarningEvent,
  getDeploymentWarningEvents,
  clearAllDeployments,
  type DeploymentResult,
  type ProgressEvent,
  type StageEvent,
  type DeploymentWarning,
} from '../../src/deployments.js';

describe('deployments', () => {
  beforeEach(() => {
    clearAllDeployments();
  });

  describe('createDeployment', () => {
    it('creates a deployment with a unique ID', () => {
      const id1 = createDeployment('project-1');
      const id2 = createDeployment('project-2');

      expect(id1).toMatch(/^deploy_\d+_[a-z0-9]+$/);
      expect(id2).toMatch(/^deploy_\d+_[a-z0-9]+$/);
      expect(id1).not.toBe(id2);
    });

    it('stores the deployment with initial state', () => {
      const projectId = 'test-project';
      const deploymentId = createDeployment(projectId);

      const deployment = getDeployment(deploymentId);
      expect(deployment).toBeDefined();
      expect(deployment?.deploymentId).toBe(deploymentId);
      expect(deployment?.projectId).toBe(projectId);
      expect(deployment?.result).toBeNull();
      expect(deployment?.error).toBeNull();
    });
  });

  describe('deploymentExists', () => {
    it('returns true for existing deployments', () => {
      const id = createDeployment('project-1');
      expect(deploymentExists(id)).toBe(true);
    });

    it('returns false for non-existent deployments', () => {
      expect(deploymentExists('deploy_nonexistent')).toBe(false);
    });
  });

  describe('setDeploymentResult', () => {
    it('stores a deployment result', () => {
      const deploymentId = createDeployment('project-1');
      const result: DeploymentResult = {
        deploymentId,
        status: 'Succeeded',
        numberComponentsDeployed: 3,
        numberComponentsTotal: 3,
        components: [{ fullName: 'Test__c', type: 'CustomObject', state: 'Created' }],
      };

      setDeploymentResult(deploymentId, result);

      const stored = getDeploymentResult(deploymentId);
      expect(stored).toEqual(result);
    });

    it('includes error message if present', () => {
      const deploymentId = createDeployment('project-1');
      const result: DeploymentResult = {
        deploymentId,
        status: 'Failed',
        numberComponentsDeployed: 0,
        numberComponentsTotal: 3,
        components: [],
        errorMessage: 'Deployment failed: invalid metadata',
      };

      setDeploymentResult(deploymentId, result);

      const stored = getDeploymentResult(deploymentId);
      expect(stored?.errorMessage).toBe('Deployment failed: invalid metadata');
    });

    it('does not store result for non-existent deployment', () => {
      const result: DeploymentResult = {
        deploymentId: 'deploy_nonexistent',
        status: 'Succeeded',
        numberComponentsDeployed: 0,
        numberComponentsTotal: 0,
      };

      // Should not throw
      setDeploymentResult('deploy_nonexistent', result);

      // Result should not be stored
      expect(getDeploymentResult('deploy_nonexistent')).toBeNull();
    });
  });

  describe('setDeploymentError', () => {
    it('stores a deployment error', () => {
      const deploymentId = createDeployment('project-1');
      const errorMsg = 'Connection failed: invalid credentials';

      setDeploymentError(deploymentId, errorMsg);

      const deployment = getDeployment(deploymentId);
      expect(deployment?.error).toBe(errorMsg);
    });

    it('does not error for non-existent deployment', () => {
      // Should not throw
      setDeploymentError('deploy_nonexistent', 'error message');
    });
  });

  describe('getDeploymentResult', () => {
    it('returns null before result is set', () => {
      const deploymentId = createDeployment('project-1');
      expect(getDeploymentResult(deploymentId)).toBeNull();
    });

    it('returns null for non-existent deployment', () => {
      expect(getDeploymentResult('deploy_nonexistent')).toBeNull();
    });
  });

  describe('getDeploymentPollPromise', () => {
    it('returns null for non-existent deployment', () => {
      expect(getDeploymentPollPromise('deploy_nonexistent')).toBeNull();
    });

    it('returns null before promise is set', () => {
      const deploymentId = createDeployment('project-1');
      expect(getDeploymentPollPromise(deploymentId)).toBeNull();
    });

    it('returns the stored promise', () => {
      const deploymentId = createDeployment('project-1');
      const promise = Promise.resolve();
      setDeploymentPollPromise(deploymentId, promise);
      expect(getDeploymentPollPromise(deploymentId)).toBe(promise);
    });
  });

  describe('addProgressEvent', () => {
    it('adds an event to an existing deployment', () => {
      const deploymentId = createDeployment('project-1');
      const event: ProgressEvent = {
        deploymentId,
        timestamp: new Date().toISOString(),
        status: 'InProgress',
        numberComponentsDeployed: 1,
        numberComponentsTotal: 3,
        components: [],
      };

      addProgressEvent(deploymentId, event);

      const events = getProgressEvents(deploymentId);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(event);
    });

    it('does not throw for non-existent deployment', () => {
      const event: ProgressEvent = {
        deploymentId: 'deploy_nonexistent',
        timestamp: new Date().toISOString(),
        status: 'InProgress',
        numberComponentsDeployed: 0,
        numberComponentsTotal: 0,
        components: [],
      };

      // Should not throw
      addProgressEvent('deploy_nonexistent', event);

      // Events should not be stored
      expect(getProgressEvents('deploy_nonexistent')).toEqual([]);
    });
  });

  describe('setDeploymentPollPromise', () => {
    it('stores a poll promise', async () => {
      const deploymentId = createDeployment('project-1');
      const promise = Promise.resolve();

      setDeploymentPollPromise(deploymentId, promise);

      const deployment = getDeployment(deploymentId);
      expect(deployment?.pollPromise).toBe(promise);
    });

    it('does not error for non-existent deployment', () => {
      const promise = Promise.resolve();
      // Should not throw
      setDeploymentPollPromise('deploy_nonexistent', promise);
    });
  });

  describe('clearAllDeployments', () => {
    it('removes all stored deployments', () => {
      const id1 = createDeployment('project-1');
      const id2 = createDeployment('project-2');

      expect(deploymentExists(id1)).toBe(true);
      expect(deploymentExists(id2)).toBe(true);

      clearAllDeployments();

      expect(deploymentExists(id1)).toBe(false);
      expect(deploymentExists(id2)).toBe(false);
    });
  });

  // The following describes cover the missing-deployment branches that
  // existed for setDeploymentResult/setDeploymentError/setDeploymentPollPromise/
  // addProgressEvent but not for the stage / warning equivalents or for
  // the bare `getDeployment`. Each setter no-ops on a missing id and each
  // getter returns the empty default. Tested explicitly so the falsy arm
  // of `if (deployment)` is exercised across every accessor.
  describe('getDeployment', () => {
    it('returns null for non-existent deployment', () => {
      expect(getDeployment('deploy_nonexistent')).toBeNull();
    });
  });

  describe('addStageEvent', () => {
    it('adds a stage event to an existing deployment', () => {
      const deploymentId = createDeployment('project-1');
      const event: StageEvent = { deploymentId, name: 'package', index: 0, total: 2 };
      addStageEvent(deploymentId, event);
      expect(getDeploymentStageEvents(deploymentId)).toEqual([event]);
    });

    it('does not throw for non-existent deployment', () => {
      const event: StageEvent = {
        deploymentId: 'deploy_nonexistent',
        name: 'package',
        index: 0,
        total: 1,
      };
      addStageEvent('deploy_nonexistent', event);
      expect(getDeploymentStageEvents('deploy_nonexistent')).toEqual([]);
    });
  });

  describe('addWarningEvent', () => {
    it('adds a warning event to an existing deployment', () => {
      const deploymentId = createDeployment('project-1');
      const event: DeploymentWarning = { stage: 'prompts', errorMessage: 'optional stage failed' };
      addWarningEvent(deploymentId, event);
      expect(getDeploymentWarningEvents(deploymentId)).toEqual([event]);
    });

    it('does not throw for non-existent deployment', () => {
      const event: DeploymentWarning = { stage: 'x', errorMessage: 'y' };
      addWarningEvent('deploy_nonexistent', event);
      expect(getDeploymentWarningEvents('deploy_nonexistent')).toEqual([]);
    });
  });
});
