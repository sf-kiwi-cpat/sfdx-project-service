import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { rename } from 'node:fs/promises';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'rename-css',
      closeBundle: async () => {
        const outDir = 'force-app/main/default/staticresources/HelpAgentApp';
        try {
          await rename(
            resolve(outDir, 'help-agent.css'),
            resolve(outDir, 'HelpAgentApp.css')
          );
        } catch { /* already named correctly */ }
      },
    },
  ],
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
