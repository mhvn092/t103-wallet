import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    fileParallelism: false,
    setupFiles: ['./test/helpers/setup-env.ts'],
    include: ['test/**/*.e2e-spec.ts', 'test/**/*.int-spec.ts'],
  },
});
