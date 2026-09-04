import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      include: ['src/{analysis,processing,io}/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'html', 'lcov']
    },
    include: ['tests/**/*.test.ts'],
    restoreMocks: true
  }
});
