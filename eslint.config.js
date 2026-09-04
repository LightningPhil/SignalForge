import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'coverage/**',
      'dist/**',
      'docs/**',
      'node_modules/**',
      'playwright-report/**',
      'reference-material/**',
      'test-results/**'
    ]
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      globals: globals.browser
    },
    rules: {
      'no-alert': 'off',
      'no-console': 'off'
    }
  },
  {
    files: ['e2e/**/*.ts', 'scripts/**/*.mjs', 'tests/**/*.ts', '*.config.{js,ts,mjs}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      }
    }
  },
  {
    files: ['public/sw.js'],
    languageOptions: {
      globals: globals.serviceworker
    }
  }
);
