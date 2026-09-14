import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const generatedRoot = resolve(packageRoot, 'demo/public/generated')

const generatedFiles = async (directory, prefix = '') => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(...(await generatedFiles(resolve(directory, entry.name), relative)))
    } else if (entry.isFile()) {
      files.push(relative)
    }
  }
  return files.sort()
}

const digestGeneratedData = async () => {
  const hash = createHash('sha256')
  let bytes = 0
  const files = await generatedFiles(generatedRoot)
  for (const relative of files) {
    const contents = await readFile(resolve(generatedRoot, relative))
    hash.update(relative)
    hash.update('\0')
    hash.update(contents)
    bytes += contents.length
  }
  return { digest: hash.digest('hex'), bytes, files: files.length }
}

const build = () =>
  new Promise((resolveBuild, reject) => {
    const started = performance.now()
    const child = spawn(process.execPath, ['scripts/build-sdf-demo.mjs'], {
      cwd: packageRoot,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`demo data build exited with ${code}`))
        return
      }
      resolveBuild(performance.now() - started)
    })
  })

const firstDuration = await build()
const first = await digestGeneratedData()
const secondDuration = await build()
const second = await digestGeneratedData()
if (first.digest !== second.digest) {
  throw new Error(`generated output changed between builds: ${first.digest} != ${second.digest}`)
}
console.log(
  `Deterministic output ${first.digest} (${first.files} files, ${(first.bytes / 1_000_000).toFixed(2)} MB; ${(firstDuration / 1000).toFixed(2)}s then ${(secondDuration / 1000).toFixed(2)}s)`,
)
