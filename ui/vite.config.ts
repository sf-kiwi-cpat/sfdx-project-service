import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/templates': 'http://localhost:3000',
      '/projects': 'http://localhost:3000',
    },
  },
});
