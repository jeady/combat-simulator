import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const srcDir = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
    // Mirror the tsconfig `src/*` path alias so headless tests resolve imports the same way.
    resolve: {
        alias: [{ find: /^src\//, replacement: `${srcDir}/` }]
    },
    test: {
        include: ['src/**/*.test.ts'],
        environment: 'node'
    }
});
