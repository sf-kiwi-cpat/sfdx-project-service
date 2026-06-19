import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Help Agent</title>
    <link rel="stylesheet" href="/resource/HelpAgentApp/HelpAgentApp.css" />
  </head>
  <body>
    <div id="root"></div>
    <script src="/resource/HelpAgentApp/HelpAgentApp.js"></script>
  </body>
</html>`;

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'post-build',
      closeBundle: async () => {
        const outDir = 'force-app/main/default/staticresources/HelpAgentApp';
        try {
          await rename(
            resolve(outDir, 'help-agent.css'),
            resolve(outDir, 'HelpAgentApp.css')
          );
        } catch { /* already named correctly */ }
        await writeFile(resolve(outDir, 'index.html'), INDEX_HTML);
      },
    },
  ],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  build: {
    lib: {
      entry: 'src/main.jsx',
      name: 'HelpAgentApp',
      formats: ['iife'],
      fileName: () => 'HelpAgentApp.js',
    },
    outDir: 'force-app/main/default/staticresources/HelpAgentApp',
    emptyOutDir: true,
    cssCodeSplit: false,
  },
});
