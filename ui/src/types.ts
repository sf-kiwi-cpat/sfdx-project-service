/** A project template returned by GET /templates */
export interface Template {
  id: string;
  name: string;
}

/** The result of POST /projects */
export interface CreateProjectResult {
  id: string;
}

/** A node in the file tree returned by GET /projects/:id/tree */
export interface TreeNode {
  name: string;
  type: 'file' | 'directory';
  path: string;
  children?: TreeNode[];
}

/** The result of POST /projects/:id/deploy */
export interface DeployResult {
  success: boolean;
  message?: string;
}

/** Credentials stored in memory after OAuth login */
export interface Credentials {
  accessToken: string;
  instanceUrl: string;
}
