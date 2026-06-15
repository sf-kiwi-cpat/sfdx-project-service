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
        const outDir = 'force-app/main/default/staticresources/EnhancedChatApp';
        try {
          await rename(
            resolve(outDir, 'enhanced-chat.css'),
            resolve(outDir, 'EnhancedChatApp.css')
          );
        } catch { /* already named correctly */ }
      },
    },
  ],
  build: {
    lib: {
      entry: 'src/main.jsx',
      name: 'EnhancedChatApp',
      formats: ['iife'],
      fileName: () => 'EnhancedChatApp.js',
    },
    outDir: 'force-app/main/default/staticresources/EnhancedChatApp',
    emptyOutDir: true,
    cssCodeSplit: false,
  },
});