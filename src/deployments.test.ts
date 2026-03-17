import { describe, it, expect, beforeEach } from 'vitest';
import {
  createDeployment,
  deploymentExists,
  getDeploymentResult,
  setDeploymentResult,
  setDeploymentError,
  getDeployment,
  setDeploymentPollPromise,
  clearAllDeployments,
  type DeploymentResult,
} from './deployments.js';

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
        components: [
          { fullName: 'Test__c', type: 'CustomObject', state: 'Created' },
        ],
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
});
