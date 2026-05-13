import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import salesforce from '@salesforce/vite-plugin-ui-bundle';

// Data Curator UI bundle.
// Root of this config is the bundle directory itself
// (force-app/main/default/uiBundles/App/). The preview-service and the
// project-service deploy-time build both root Vite here.
//
// During dev, the @salesforce/vite-plugin-ui-bundle middleware proxies
// /services/* to the target org with real Salesforce auth and injects the
// live-preview script. During `vite build`, it injects API-version + base
// tag into index.html and emits the bundle to ./dist (the location
// declared in ui-bundle.json).
export default defineConfig({
  base: './',
  plugins: [react(), salesforce()],
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
  },
});
