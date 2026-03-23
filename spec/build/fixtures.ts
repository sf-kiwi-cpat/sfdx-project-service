/**
 * Shared test fixtures for Vite build integration spec tests
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Create a React project with .tsx source files.
 *
 * Directory layout:
 *   sfdx-project.json
 *   index.html              (Vite entry)
 *   src/main.tsx             (React entry point)
 *   src/App.tsx              (React component)
 *   force-app/main/default/staticresources/   (build output target)
 */
export async function createReactProject(
  tmpDir: string,
  name: string
): Promise<{ projectId: string }> {
  const projectId = randomUUID();
  const projectDir = path.join(tmpDir, projectId);

  await fs.mkdir(path.join(projectDir, 'src'), { recursive: true });
  await fs.mkdir(path.join(projectDir, 'force-app/main/default/staticresources'), {
    recursive: true,
  });

  await fs.writeFile(
    path.join(projectDir, 'sfdx-project.json'),
    JSON.stringify(
      {
        packageDirectories: [{ path: 'force-app', default: true }],
        namespace: '',
        sfdcLoginUrl: 'https://login.salesforce.com',
        sourceApiVersion: '60.0',
      },
      null,
      2
    )
  );

  await fs.writeFile(
    path.join(projectDir, 'index.html'),
    [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head><meta charset="UTF-8" /><title>' + name + '</title></head>',
      '<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>',
      '</html>',
    ].join('\n')
  );

  await fs.writeFile(
    path.join(projectDir, 'src/main.tsx'),
    [
      "import React from 'react';",
      "import ReactDOM from 'react-dom/client';",
      "import App from './App';",
      "ReactDOM.createRoot(document.getElementById('root')!).render(<App />);",
    ].join('\n')
  );

  await fs.writeFile(
    path.join(projectDir, 'src/App.tsx'),
    [
      "import React from 'react';",
      'export default function App() { return <h1>' + name + '</h1>; }',
    ].join('\n')
  );

  return { projectId };
}

/**
 * Create a metadata-only SFDX project with no .tsx or .jsx files.
 *
 * Directory layout:
 *   sfdx-project.json
 *   force-app/main/default/objects/   (metadata structure, no tsx/jsx)
 */
export async function createMetadataOnlyProject(
  tmpDir: string
): Promise<{ projectId: string }> {
  const projectId = randomUUID();
  const projectDir = path.join(tmpDir, projectId);

  await fs.mkdir(path.join(projectDir, 'force-app/main/default/objects'), {
    recursive: true,
  });

  await fs.writeFile(
    path.join(projectDir, 'sfdx-project.json'),
    JSON.stringify(
      {
        packageDirectories: [{ path: 'force-app', default: true }],
        namespace: '',
        sfdcLoginUrl: 'https://login.salesforce.com',
        sourceApiVersion: '60.0',
      },
      null,
      2
    )
  );

  return { projectId };
}
