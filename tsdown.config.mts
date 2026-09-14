import { defineConfig } from 'tsdown'

const entries = [
  'src/index.ts',
  'src/compiler/index.ts',
  'src/sdf-runtime/index.ts',
  'src/build/index.ts',
  'src/cli.ts',
]

export default defineConfig({
  entry: entries,
  format: ['esm'],
  target: 'es2022',
  dts: true,
  clean: true,
})
