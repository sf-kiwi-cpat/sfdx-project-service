import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { execSync } from 'child_process';

// Determine if we're on main branch
const isMainBranch = (() => {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
    return branch === 'main';
  } catch {
    return false;
  }
})();

// Use different thresholds for main vs branches
const thresholds = isMainBranch
  ? { lines: 90, branches: 90, functions: 90, statements: 90 }
  : { lines: 85, branches: 85, functions: 85, statements: 85 };

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'spec/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/**/*.test.ts'],
      thresholds,
    },
  },
});
