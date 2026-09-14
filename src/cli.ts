import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { parseArgs } from 'node:util'
import { buildGlyphflux } from './build'

export interface GlyphfluxCliIo {
  stdout: (message: string) => void
  stderr: (message: string) => void
}

const defaultIo: GlyphfluxCliIo = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
}

function help() {
  return `Usage: glyphflux <command> [options]

Commands:
  build       Discover text and generate prepared font-morph data

Options:
  -c, --config <path>  Configuration file (default: glyphflux.config.json)
      --dry-run        Validate and compile without writing artifacts
  -h, --help           Show this help
  -v, --version        Show the installed Glyphflux version`
}

async function packageVersion() {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  return String(packageJson.version)
}

function errorMessage(error: unknown) {
  if (!(error instanceof Error)) return String(error)
  const causes: string[] = []
  let current: unknown = error
  while (current instanceof Error) {
    if (!causes.includes(current.message)) causes.push(current.message)
    current = current.cause
  }
  return causes.join('\n  caused by: ')
}

export async function runGlyphfluxCli(
  argv = process.argv.slice(2),
  io: GlyphfluxCliIo = defaultIo,
) {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: 'string', short: 'c' },
        'dry-run': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    })
  } catch (error) {
    io.stderr(errorMessage(error))
    io.stderr(help())
    return 1
  }

  if (parsed.values.version) {
    io.stdout(await packageVersion())
    return 0
  }
  if (parsed.values.help || parsed.positionals.length === 0) {
    io.stdout(help())
    return 0
  }
  const [command, ...extra] = parsed.positionals
  if (command !== 'build' || extra.length) {
    io.stderr(`Unknown command: ${parsed.positionals.join(' ')}`)
    io.stderr(help())
    return 1
  }

  try {
    const started = performance.now()
    const config = parsed.values.config
    const result = await buildGlyphflux({
      ...(typeof config === 'string' ? { config } : {}),
      write: !parsed.values['dry-run'],
    })
    const root = process.cwd()
    const size = result.manifests.reduce((total, manifest) => total + manifest.bytes, 0)
    const verb = parsed.values['dry-run'] ? 'validated' : 'wrote'
    io.stdout(
      `Glyphflux ${verb} ${result.morphs} morph${result.morphs === 1 ? '' : 's'} for ${result.locales.length} locale${result.locales.length === 1 ? '' : 's'} (${(size / 1_000_000).toFixed(2)} MB) in ${(performance.now() - started).toFixed(0)}ms.`,
    )
    if (!parsed.values['dry-run']) {
      for (const manifest of result.manifests) {
        io.stdout(`  ${manifest.locale}: ${relative(root, manifest.path)}`)
      }
      if (result.runtimeModule) io.stdout(`  runtime: ${relative(root, result.runtimeModule)}`)
    }
    return 0
  } catch (error) {
    io.stderr(`Glyphflux build failed: ${errorMessage(error)}`)
    return 1
  }
}
