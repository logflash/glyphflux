import { copyFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const outputDirectory = resolve(packageRoot, 'demo-dist/client')

await mkdir(outputDirectory, { recursive: true })
await copyFile(
  resolve(packageRoot, 'glyphflux.schema.json'),
  resolve(outputDirectory, 'config-schema.json'),
)
