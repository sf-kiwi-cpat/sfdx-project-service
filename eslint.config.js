import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import notice from 'eslint-plugin-notice';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.claude/worktrees/**', 'eslint.config.js', 'license-header.js', 'scripts/**', 'ui/**', 'templates/**', 'projects/**', 'coverage/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { notice },
    rules: {
      'notice/notice': ['error', {
        templateFile: './license-header.js',
        onNonMatchingHeader: 'replace',
        varRegexps: { YEAR: /20[0-9]{2}/ },
      }],
    },
  },
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  }
);
