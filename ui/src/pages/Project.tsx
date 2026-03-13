import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getProjectTree, deployProject } from '../api';
import { getCredentials } from '../auth';
import FileTree from '../components/FileTree';
import type { TreeNode, DeployResult } from '../types';
import './Project.css';

export default function Project() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [tree, setTree] = useState<TreeNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<DeployResult | null>(null);

  useEffect(() => {
    if (!id) return;
    getProjectTree(id)
      .then(setTree)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load file tree'))
      .finally(() => setLoading(false));
  }, [id]);

  async function handleDeploy() {
    if (!id) return;
    const creds = getCredentials();
    if (!creds) return;

    try {
      setDeploying(true);
      setDeployResult(null);
      const result = await deployProject(id, creds.accessToken, creds.instanceUrl);
      setDeployResult(result);
    } catch (err) {
      setDeployResult({
        success: false,
        message: err instanceof Error ? err.message : 'Deploy failed',
      });
    } finally {
      setDeploying(false);
    }
  }

  return (
    <div className="project-page">
      {/* Header */}
      <header className="project-header">
        <div className="project-header-inner">
          <div className="project-header-left">
            <button className="project-back" onClick={() => navigate('/home')}>
              &larr; Home
            </button>
            <span className="project-id">Project: {id}</span>
          </div>
          <button
            className="project-deploy-btn"
            onClick={handleDeploy}
            disabled={deploying || loading}
          >
            {deploying ? 'Deploying...' : 'Deploy'}
          </button>
        </div>
      </header>

      {/* Deploy result banner */}
      {deployResult && (
        <div
          className={`project-banner ${deployResult.success ? 'project-banner--success' : 'project-banner--error'}`}
        >
          {deployResult.success
            ? deployResult.message ?? 'Deployment succeeded!'
            : deployResult.message ?? 'Deployment failed.'}
        </div>
      )}

      {/* Content */}
      <main className="project-main">
        {loading && <p className="project-status">Loading file tree...</p>}
        {error && <p className="project-status project-status--error">{error}</p>}
        {tree && <FileTree node={tree} />}
      </main>
    </div>
  );
}
