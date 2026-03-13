import type { Template, CreateProjectResult, TreeNode, DeployResult } from './types';

/**
 * Fetch available project templates.
 * GET /templates
 */
export async function getTemplates(): Promise<Template[]> {
  const res = await fetch('/templates');
  if (!res.ok) throw new Error(`Failed to fetch templates: ${res.statusText}`);
  return res.json();
}

/**
 * Create a new project from a template.
 * POST /projects
 */
export async function createProject(templateId: string): Promise<CreateProjectResult> {
  const res = await fetch('/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ template: templateId }),
  });
  if (!res.ok) throw new Error(`Failed to create project: ${res.statusText}`);
  return res.json();
}

/**
 * Get the file tree for a project.
 * GET /projects/:id/tree
 */
export async function getProjectTree(projectId: string): Promise<TreeNode> {
  const res = await fetch(`/projects/${projectId}/tree`);
  if (!res.ok) throw new Error(`Failed to fetch project tree: ${res.statusText}`);
  return res.json();
}

/**
 * Deploy a project to a Salesforce org.
 * POST /projects/:id/deploy
 */
export async function deployProject(
  projectId: string,
  accessToken: string,
  instanceUrl: string
): Promise<DeployResult> {
  const res = await fetch(`/projects/${projectId}/deploy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken, instanceUrl }),
  });
  if (!res.ok) throw new Error(`Deploy failed: ${res.statusText}`);
  return res.json();
}
