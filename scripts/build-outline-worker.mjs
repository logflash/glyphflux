import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

await build({
  absWorkingDir: packageRoot,
  entryPoints: ['./src/outline.worker.ts'],
  outfile: 'dist/outline-worker.js',
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
})
