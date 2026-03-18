/**
 * Shared test fixtures for build integration spec tests
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export interface CreateProjectWithPackageJsonOptions {
  skipBuildScript?: boolean;
}

/**
 * Create a temporary project directory with package.json and a build script
 */
export async function createProjectWithPackageJson(
  tmpDir: string,
  projectName: string,
  options: CreateProjectWithPackageJsonOptions = {}
): Promise<{ tmpDir: string; projectId: string }> {
  const projectDir = path.join(tmpDir, projectName);
  await fs.mkdir(projectDir, { recursive: true });

  const packageJson = {
    name: projectName,
    version: '1.0.0',
    scripts: {
      ...(options.skipBuildScript ? {} : { build: 'echo "Building..."' }),
    },
  };

  await fs.writeFile(
    path.join(projectDir, 'package.json'),
    JSON.stringify(packageJson, null, 2)
  );

  return {
    tmpDir: projectDir,
    projectId: projectName,
  };
}

/**
 * Create a temporary project directory without package.json
 */
export async function createProjectWithoutPackageJson(tmpDir: string): Promise<{
  tmpDir: string;
  projectId: string;
}> {
  const projectDir = path.join(tmpDir, 'no-package-json');
  await fs.mkdir(projectDir, { recursive: true });

  // Create sfdx-project.json to make it a valid SFDX project
  const sfdxProject = {
    packageDirectories: [{ path: 'force-app', default: true }],
    namespace: '',
    sfdcLoginUrl: 'https://login.salesforce.com',
    sourceApiVersion: '60.0',
  };

  await fs.writeFile(
    path.join(projectDir, 'sfdx-project.json'),
    JSON.stringify(sfdxProject, null, 2)
  );

  return {
    tmpDir: projectDir,
    projectId: 'no-package-json',
  };
}
