import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    // Les tests visuels (Playwright) ont leur propre configuration.
    exclude: ['tests/visual/**', 'node_modules/**'],
    restoreMocks: true,
    unstubEnvs: true,
  },
});
