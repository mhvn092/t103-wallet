import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    fileParallelism: false,
    include: ['test/**/*.e2e-spec.ts', 'test/**/*.int-spec.ts'],
  },
});
