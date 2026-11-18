import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-skill-filesystem',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/schemastery',
  ],
})
