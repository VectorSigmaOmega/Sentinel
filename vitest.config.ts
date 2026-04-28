import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@sentinel/ontology': new URL('./packages/ontology/src/index.ts', import.meta.url).pathname,
      '@sentinel/impact': new URL('./packages/impact/src/index.ts', import.meta.url).pathname,
      '@sentinel/recommendation': new URL('./packages/recommendation/src/index.ts', import.meta.url).pathname,
      '@sentinel/routing': new URL('./packages/routing/src/index.ts', import.meta.url).pathname,
      '@sentinel/scenario-generator': new URL('./packages/scenario-generator/src/index.ts', import.meta.url).pathname,
      '@sentinel/shared': new URL('./packages/shared/src/index.ts', import.meta.url).pathname,
    },
  },
});
