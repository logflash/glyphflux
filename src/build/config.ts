import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export type GlyphfluxFontRole = 'sans' | 'serif'

export interface GlyphfluxMdxSelector {
  kind: 'heading' | 'element'
  depth?: number
  name?: string
  textAttribute?: string
  attributes?: Record<string, string | boolean>
}

export interface GlyphfluxDocumentConfig {
  include: string[]
  exclude?: string[]
  format: 'mdx'
  sources: GlyphfluxMdxSelector[]
  targets: GlyphfluxMdxSelector[]
}

export interface GlyphfluxCatalogConfig {
  path: string
  sourceLookup?: 'value'
}

export interface GlyphfluxFontFileConfig {
  file: string
  faceIndex?: number
}

export type GlyphfluxFontConfig = string | GlyphfluxFontFileConfig

export interface GlyphfluxInstanceSetConfig {
  role: GlyphfluxFontRole
  weights: number[]
  opticalSizes: number[]
}

export interface GlyphfluxMorphConfig {
  source: GlyphfluxInstanceSetConfig
  target: GlyphfluxInstanceSetConfig
}

export interface GlyphfluxCompilerConfig {
  size?: number
  pixelsPerEm?: number
  maximumDistance?: number
  supersampling?: number
  texturePadding?: number
}

export interface GlyphfluxOutputConfig {
  manifests: string
  runtimeModule?: string
  runtimeExport?: string
}

export interface GlyphfluxConfig {
  $schema?: string
  defaultLocale?: string
  locales?: string[]
  catalogs?: GlyphfluxCatalogConfig
  documents?: GlyphfluxDocumentConfig[]
  texts?: string[]
  fonts: Record<GlyphfluxFontRole, GlyphfluxFontConfig[]>
  morphs: GlyphfluxMorphConfig[]
  compiler?: GlyphfluxCompilerConfig
  output: GlyphfluxOutputConfig
}

export interface LoadedGlyphfluxConfig {
  config: GlyphfluxConfig
  path: string
  root: string
}

function configError(path: string, message: string): never {
  throw new Error(`${path}: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringArray(value: unknown, path: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    return configError(path, 'must be an array of strings')
  }
  if (!allowEmpty && value.length === 0) return configError(path, 'must not be empty')
  return [...value]
}

function numberArray(value: unknown, path: string): number[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))
  ) {
    return configError(path, 'must be a nonempty array of finite numbers')
  }
  return [...new Set(value)].sort((left, right) => left - right)
}

function positiveInteger(value: unknown, path: string) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    return configError(path, 'must be a positive integer')
  }
  return Number(value)
}

function selector(value: unknown, path: string): GlyphfluxMdxSelector {
  if (!isRecord(value)) return configError(path, 'must be an object')
  const kind = value.kind
  if (kind !== 'heading' && kind !== 'element') {
    return configError(`${path}.kind`, 'must be "heading" or "element"')
  }
  if (kind === 'heading' && value.depth !== undefined) {
    const depth = positiveInteger(value.depth, `${path}.depth`)
    if (depth > 6) return configError(`${path}.depth`, 'must be between 1 and 6')
  }
  if (kind === 'element' && typeof value.name !== 'string') {
    return configError(`${path}.name`, 'is required for element selectors')
  }
  if (value.textAttribute !== undefined && typeof value.textAttribute !== 'string') {
    return configError(`${path}.textAttribute`, 'must be a string')
  }
  if (value.attributes !== undefined) {
    if (!isRecord(value.attributes)) {
      return configError(`${path}.attributes`, 'must be an object')
    }
    for (const [name, expected] of Object.entries(value.attributes)) {
      if (typeof expected !== 'string' && typeof expected !== 'boolean') {
        return configError(`${path}.attributes.${name}`, 'must be a string or boolean')
      }
    }
  }
  return value as unknown as GlyphfluxMdxSelector
}

function documentConfig(value: unknown, path: string): GlyphfluxDocumentConfig {
  if (!isRecord(value)) return configError(path, 'must be an object')
  if (value.format !== 'mdx') return configError(`${path}.format`, 'must be "mdx"')
  const sources = Array.isArray(value.sources)
    ? value.sources.map((entry, index) => selector(entry, `${path}.sources[${index}]`))
    : configError(`${path}.sources`, 'must be an array')
  const targets = Array.isArray(value.targets)
    ? value.targets.map((entry, index) => selector(entry, `${path}.targets[${index}]`))
    : configError(`${path}.targets`, 'must be an array')
  if (!sources.length) configError(`${path}.sources`, 'must not be empty')
  if (!targets.length) configError(`${path}.targets`, 'must not be empty')
  return {
    include: stringArray(value.include, `${path}.include`),
    ...(value.exclude === undefined
      ? {}
      : { exclude: stringArray(value.exclude, `${path}.exclude`, true) }),
    format: 'mdx',
    sources,
    targets,
  }
}

function fontConfig(value: unknown, path: string): GlyphfluxFontConfig {
  if (typeof value === 'string') return value
  if (!isRecord(value) || typeof value.file !== 'string') {
    return configError(path, 'must be a file path or an object containing file')
  }
  if (
    value.faceIndex !== undefined &&
    (!Number.isSafeInteger(value.faceIndex) || Number(value.faceIndex) < 0)
  ) {
    return configError(`${path}.faceIndex`, 'must be a non-negative integer')
  }
  return {
    file: value.file,
    ...(value.faceIndex === undefined ? {} : { faceIndex: Number(value.faceIndex) }),
  }
}

function instanceSet(value: unknown, path: string): GlyphfluxInstanceSetConfig {
  if (!isRecord(value)) return configError(path, 'must be an object')
  if (value.role !== 'sans' && value.role !== 'serif') {
    return configError(`${path}.role`, 'must be "sans" or "serif"')
  }
  return {
    role: value.role,
    weights: numberArray(value.weights, `${path}.weights`),
    opticalSizes: numberArray(value.opticalSizes, `${path}.opticalSizes`),
  }
}

export function validateGlyphfluxConfig(value: unknown, path = 'glyphflux.config.json') {
  if (!isRecord(value)) return configError(path, 'must contain a JSON object')

  const fonts = value.fonts
  if (!isRecord(fonts)) configError(`${path}.fonts`, 'must be an object')
  const normalizedFonts = Object.fromEntries(
    (['sans', 'serif'] as const).map((role) => {
      const entries = fonts[role]
      if (!Array.isArray(entries) || entries.length === 0) {
        return configError(`${path}.fonts.${role}`, 'must be a nonempty array')
      }
      return [role, entries.map((entry, index) => fontConfig(entry, `${path}.fonts.${role}[${index}]`))]
    }),
  ) as Record<GlyphfluxFontRole, GlyphfluxFontConfig[]>

  if (!Array.isArray(value.morphs) || value.morphs.length === 0) {
    configError(`${path}.morphs`, 'must be a nonempty array')
  }
  const morphs = value.morphs.map((entry, index) => {
    if (!isRecord(entry)) return configError(`${path}.morphs[${index}]`, 'must be an object')
    return {
      source: instanceSet(entry.source, `${path}.morphs[${index}].source`),
      target: instanceSet(entry.target, `${path}.morphs[${index}].target`),
    }
  })

  const documents =
    value.documents === undefined
      ? []
      : Array.isArray(value.documents)
        ? value.documents.map((entry, index) =>
            documentConfig(entry, `${path}.documents[${index}]`),
          )
        : configError(`${path}.documents`, 'must be an array')
  const texts =
    value.texts === undefined ? [] : stringArray(value.texts, `${path}.texts`, true)
  if (!documents.length && !texts.length) {
    configError(path, 'must configure at least one document or text')
  }

  let catalogs: GlyphfluxCatalogConfig | undefined
  if (value.catalogs !== undefined) {
    if (!isRecord(value.catalogs) || typeof value.catalogs.path !== 'string') {
      configError(`${path}.catalogs`, 'must be an object containing path')
    }
    if (value.catalogs.sourceLookup !== undefined && value.catalogs.sourceLookup !== 'value') {
      configError(`${path}.catalogs.sourceLookup`, 'must be "value"')
    }
    if (!value.catalogs.path.includes('[locale]')) {
      configError(`${path}.catalogs.path`, 'must contain [locale]')
    }
    catalogs = {
      path: value.catalogs.path,
      sourceLookup: 'value',
    }
  }

  const defaultLocale = value.defaultLocale === undefined ? 'und' : value.defaultLocale
  if (typeof defaultLocale !== 'string' || !defaultLocale) {
    configError(`${path}.defaultLocale`, 'must be a nonempty string')
  }
  const locales =
    value.locales === undefined ? [] : stringArray(value.locales, `${path}.locales`, true)
  if (new Set(locales).size !== locales.length) {
    configError(`${path}.locales`, 'must not contain duplicates')
  }
  if (locales.includes(defaultLocale)) {
    configError(`${path}.locales`, 'must not repeat defaultLocale')
  }
  if (locales.length && !catalogs) {
    configError(`${path}.catalogs`, 'is required when target locales are configured')
  }

  const compilerValue = value.compiler
  if (compilerValue !== undefined && !isRecord(compilerValue)) {
    configError(`${path}.compiler`, 'must be an object')
  }
  const compilerRecord = (compilerValue ?? {}) as Record<string, unknown>
  const compiler: GlyphfluxCompilerConfig = {}
  for (const key of [
    'size',
    'pixelsPerEm',
    'maximumDistance',
    'supersampling',
    'texturePadding',
  ] as const) {
    if (compilerRecord[key] !== undefined) {
      compiler[key] = positiveInteger(compilerRecord[key], `${path}.compiler.${key}`)
    }
  }

  if (!isRecord(value.output) || typeof value.output.manifests !== 'string') {
    configError(`${path}.output`, 'must be an object containing manifests')
  }
  if (locales.length && !value.output.manifests.includes('[locale]')) {
    configError(`${path}.output.manifests`, 'must contain [locale] for a multilingual build')
  }
  if (
    value.output.runtimeModule !== undefined &&
    typeof value.output.runtimeModule !== 'string'
  ) {
    configError(`${path}.output.runtimeModule`, 'must be a string')
  }
  if (
    value.output.runtimeExport !== undefined &&
    (typeof value.output.runtimeExport !== 'string' ||
      !/^[$A-Z_a-z][$\w]*$/u.test(value.output.runtimeExport))
  ) {
    configError(`${path}.output.runtimeExport`, 'must be a JavaScript identifier')
  }

  return {
    ...value,
    defaultLocale,
    locales,
    ...(catalogs ? { catalogs } : {}),
    documents,
    texts,
    fonts: normalizedFonts,
    morphs,
    compiler,
    output: {
      manifests: value.output.manifests,
      ...(value.output.runtimeModule === undefined
        ? {}
        : { runtimeModule: value.output.runtimeModule }),
      runtimeExport: value.output.runtimeExport ?? 'glyphfluxLocaleByText',
    },
  } as GlyphfluxConfig
}

export async function loadGlyphfluxConfig(
  configPath = 'glyphflux.config.json',
  cwd = process.cwd(),
): Promise<LoadedGlyphfluxConfig> {
  const path = resolve(cwd, configPath)
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(`Unable to read Glyphflux configuration at ${path}`, { cause: error })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}`, { cause: error })
  }
  return {
    config: validateGlyphfluxConfig(parsed, path),
    path,
    root: dirname(path),
  }
}

export function defineGlyphfluxConfig(config: GlyphfluxConfig) {
  return config
}
