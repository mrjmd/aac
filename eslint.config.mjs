// Root ESLint flat config for every workspace. Each workspace runs
// `eslint .` from its own directory; ESLint finds this file by walking up.
//
// Baseline: @eslint/js recommended + typescript-eslint recommended (+ the
// Next.js plugin for the Next apps). Every rule that fired on the existing
// code when this was added is downgraded to "warn" below so `pnpm turbo lint`
// exits 0 today. Tighten one rule at a time by deleting its line (back to
// "error") once its warnings are cleaned up.
import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.astro/**',
      '**/.turbo/**',
      '**/.vercel/**',
      '**/coverage/**',
      '**/next-env.d.ts',
      'tools/src/scratch/**',
      'docs/social-post-dj/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'warn',
    },
  },
  {
    files: ['apps/command-center/**', 'apps/field/**', 'apps/marketing/**'],
    plugins: { '@next/next': nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      // App Router only; this rule looks for a pages/ directory.
      '@next/next/no-html-link-for-pages': 'off',
    },
  },
  {
    // Baseline downgrades: these fire on existing code (counts at adoption
    // in the commit message). Remove a line to make that rule an error.
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      'no-useless-assignment': 'warn',
      'no-useless-escape': 'warn',
      'prefer-const': 'warn',
      'preserve-caught-error': 'warn',
    },
  },
);
