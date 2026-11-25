import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        'src/**/*.module.ts',
        'src/**/dto/**',
        'src/**/*.dto.ts',
        'src/**/*.schema.ts',
        'src/**/*.schemas.ts',
        'src/**/*.interface.ts',
        'src/**/*.types.ts',
        'src/common/enums/**',
        'src/common/constants/**',
        'src/modules/**/*.constants.ts',
        'src/**/main.ts',
        'src/**/app.module.ts',
        'src/app.setup.ts',
        'src/database/database.service.ts',
        'src/database/migrate.ts',
      ],
    },
  },
});

