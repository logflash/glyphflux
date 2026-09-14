import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import type { FontMorphOutlineInstance, FontMorphPreparedSdfMorph } from '../index'
import { compileFontMorphManifest, fontMorphPreparedKey } from '../index'
import {
  createSdfTextMorphCompiler,
  parseFontMorphFont,
  stableStringify,
  type FontMorphFontInput,
  type FontMorphSerializedSdfGlyphPair,
  type FontMorphSdfGlyphPair,
} from '../compiler'
import { createHarfBuzzRunShaper } from '../compiler/harfbuzz'
import type {
  GlyphfluxConfig,
  GlyphfluxFontConfig,
  GlyphfluxFontRole,
  LoadedGlyphfluxConfig,
} from './config'
import { loadGlyphfluxConfig } from './config'
import { discoverGlyphfluxText } from './documents'

interface FontSource {
  file: string
  fileIndex: number
  faceIndex?: number
  data: ArrayBuffer
  parsed: ReturnType<typeof parseFontMorphFont>
}

interface LocaleTexts {
  locale: string
  texts: string[]
}

interface CompilePlan {
  key: string
  locale: string
  text: string
  source: FontMorphOutlineInstance
  target: FontMorphOutlineInstance
  sourceFont: SelectedFont
  targetFont: SelectedFont
  groupKey: string
}

interface CompileRequest {
  locale: string
  text: string
  source: FontMorphOutlineInstance
  target: FontMorphOutlineInstance
}

interface SelectedFont extends FontSource {
  input: FontMorphFontInput
  instantiated: ReturnType<typeof parseFontMorphFont>
}

export interface GlyphfluxBuildOptions {
  config?: string
  cwd?: string
  write?: boolean
}

export interface GlyphfluxBuildResult {
  configPath: string
  documents: string[]
  locales: string[]
  sourceTexts: string[]
  morphs: number
  manifests: { locale: string; path: string; bytes: number }[]
  runtimeModule?: string
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

function fontPath(config: GlyphfluxFontConfig) {
  return typeof config === 'string' ? config : config.file
}

function fontFaceIndex(config: GlyphfluxFontConfig) {
  return typeof config === 'string' ? undefined : config.faceIndex
}

async function arrayBuffer(path: string) {
  const value = await readFile(path)
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
}

async function loadFontSources(
  config: GlyphfluxConfig,
  root: string,
): Promise<Record<GlyphfluxFontRole, FontSource[]>> {
  return Object.fromEntries(
    await Promise.all(
      (['sans', 'serif'] as const).map(async (role) => [
        role,
        await Promise.all(
          config.fonts[role].map(async (font, fileIndex) => {
            const file = resolve(root, fontPath(font))
            const faceIndex = fontFaceIndex(font)
            const data = await arrayBuffer(file)
            let parsed: ReturnType<typeof parseFontMorphFont>
            try {
              parsed = parseFontMorphFont({
                data,
                ...(faceIndex === undefined ? {} : { faceIndex }),
              })
            } catch (error) {
              throw new Error(`Unable to parse ${relative(root, file)}`, { cause: error })
            }
            return { file, fileIndex, faceIndex, data, parsed }
          }),
        ),
      ]),
    ),
  ) as Record<GlyphfluxFontRole, FontSource[]>
}

function supportsText(source: FontSource, text: string) {
  return [...text].every(
    (character) =>
      character === '\0' || source.parsed.outlineFont.glyphForCodePoint(character.codePointAt(0)!).id !== 0,
  )
}

function variationAxes(instance: FontMorphOutlineInstance, source: FontSource) {
  const available =
    (source.parsed.outlineFont as typeof source.parsed.outlineFont & {
      variationAxes?: Record<string, unknown>
    }).variationAxes ?? {}
  return {
    ...(available.wght ? { wght: instance.weight } : {}),
    ...(available.opsz && instance.opticalSize > 0 ? { opsz: instance.opticalSize } : {}),
  }
}

function selectFont(
  sources: Record<GlyphfluxFontRole, FontSource[]>,
  instance: FontMorphOutlineInstance,
  text: string,
): SelectedFont {
  const source = sources[instance.role].find((candidate) => supportsText(candidate, text))
  if (!source) {
    throw new Error(
      `No ${instance.role} font contains every character in ${JSON.stringify(text)}`,
    )
  }
  const axes = variationAxes(instance, source)
  const input: FontMorphFontInput = {
    data: source.data,
    ...(source.faceIndex === undefined ? {} : { faceIndex: source.faceIndex }),
    ...(Object.keys(axes).length ? { axes } : {}),
  }
  return { ...source, input, instantiated: parseFontMorphFont(input) }
}

function flatStringCatalog(value: unknown, path: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path}: catalog must be a JSON object`)
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

async function resolveLocaleTexts(
  loaded: LoadedGlyphfluxConfig,
  sourceTexts: readonly string[],
): Promise<LocaleTexts[]> {
  const { config, root } = loaded
  const locales = [config.defaultLocale!, ...(config.locales ?? [])]
  if (!config.catalogs) {
    return [{ locale: config.defaultLocale!, texts: [...sourceTexts] }]
  }

  const catalogs = Object.fromEntries(
    await Promise.all(
      locales.map(async (locale) => {
        const path = resolve(root, config.catalogs!.path.replaceAll('[locale]', locale))
        let parsed: unknown
        try {
          parsed = JSON.parse(await readFile(path, 'utf8'))
        } catch (error) {
          throw new Error(`Unable to read Glyphflux catalog ${relative(root, path)}`, {
            cause: error,
          })
        }
        return [locale, flatStringCatalog(parsed, relative(root, path))]
      }),
    ),
  )
  const sourceCatalog = catalogs[config.defaultLocale!]
  const keys = sourceTexts.map((text) => {
    const matches = Object.entries(sourceCatalog)
      .filter(([, value]) => value === text)
      .map(([key]) => key)
      .sort(compareText)
    if (!matches.length) {
      throw new Error(
        `Unable to find Glyphflux source ${JSON.stringify(text)} in ${config.defaultLocale} catalog`,
      )
    }
    if (matches.length > 1) {
      throw new Error(
        `Glyphflux source ${JSON.stringify(text)} is ambiguous in ${config.defaultLocale} catalog (${matches.join(', ')})`,
      )
    }
    return matches[0]
  })

  return locales.map((locale) => ({
    locale,
    texts: keys.map((key, index) => {
      const text = catalogs[locale][key]
      if (typeof text !== 'string' || !text) {
        throw new Error(
          `${config.catalogs!.path.replaceAll('[locale]', locale)}: missing translation for ${JSON.stringify(sourceTexts[index])}`,
        )
      }
      return text
    }),
  }))
}

function compileRequests(config: GlyphfluxConfig, localeTexts: readonly LocaleTexts[]) {
  const requests: CompileRequest[] = []
  for (const { locale, texts } of localeTexts) {
    for (const text of texts) {
      for (const morph of config.morphs) {
        for (const sourceWeight of morph.source.weights) {
          for (const sourceOpticalSize of morph.source.opticalSizes) {
            for (const targetWeight of morph.target.weights) {
              for (const targetOpticalSize of morph.target.opticalSizes) {
                requests.push({
                  locale,
                  text,
                  source: {
                    role: morph.source.role,
                    weight: sourceWeight,
                    opticalSize: sourceOpticalSize,
                  },
                  target: {
                    role: morph.target.role,
                    weight: targetWeight,
                    opticalSize: targetOpticalSize,
                  },
                })
              }
            }
          }
        }
      }
    }
  }
  return requests
}

function serializeGlyph(glyph: FontMorphSdfGlyphPair): FontMorphSerializedSdfGlyphPair {
  const { distance: sourceDistance, ...source } = glyph.source
  const { distance: targetDistance, ...target } = glyph.target
  return {
    ...glyph,
    source: {
      ...source,
      distanceBase64: Buffer.from(sourceDistance).toString('base64'),
    },
    target: {
      ...target,
      distanceBase64: Buffer.from(targetDistance).toString('base64'),
    },
  }
}

async function writeGenerated(path: string, contents: string, write: boolean) {
  if (write) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents)
  }
  return Buffer.byteLength(contents)
}

function outputPath(pattern: string, locale: string, root: string) {
  return resolve(root, pattern.replaceAll('[locale]', locale))
}

export async function buildGlyphflux(options: GlyphfluxBuildOptions = {}): Promise<GlyphfluxBuildResult> {
  const loaded = await loadGlyphfluxConfig(options.config, options.cwd)
  const write = options.write !== false
  const discovered = await discoverGlyphfluxText(loaded)
  const localeTexts = await resolveLocaleTexts(loaded, discovered.sources)
  const requests = compileRequests(loaded.config, localeTexts)
  const sources = await loadFontSources(loaded.config, loaded.root)
  const buffers = Object.fromEntries(
    Object.entries(sources).map(([role, entries]) => [
      role,
      entries.map(({ data }) => data),
    ]),
  ) as Record<GlyphfluxFontRole, ArrayBuffer[]>

  const uniqueRequests = new Map(
    requests.map((request) => [
      fontMorphPreparedKey(request.text, request.source, request.target),
      request,
    ]),
  )
  const outlines = await compileFontMorphManifest(
    buffers,
    [...uniqueRequests.values()].map(({ text, source, target }) => ({ text, source, target })),
  )

  const plans: CompilePlan[] = [...uniqueRequests.values()]
    .map((request) => {
      const sourceFont = selectFont(sources, request.source, request.text)
      const targetFont = selectFont(sources, request.target, request.text)
      return {
        ...request,
        key: fontMorphPreparedKey(request.text, request.source, request.target),
        sourceFont,
        targetFont,
        groupKey: stableStringify({
          sourceFile: sourceFont.file,
          sourceInstance: sourceFont.instantiated.instance,
          targetFile: targetFont.file,
          targetInstance: targetFont.instantiated.instance,
        }),
      }
    })
    .sort((left, right) => compareText(left.key, right.key))

  const shaper = createHarfBuzzRunShaper()
  const compilers = new Map<string, ReturnType<typeof createSdfTextMorphCompiler>>()
  const sdfMorphs: Record<string, FontMorphPreparedSdfMorph> = {}
  for (const plan of plans) {
    let compiler = compilers.get(plan.groupKey)
    if (!compiler) {
      compiler = createSdfTextMorphCompiler(plan.sourceFont.input, plan.targetFont.input, {
        ...loaded.config.compiler,
        shaper,
      })
      compilers.set(plan.groupKey, compiler)
    }
    let compiled
    try {
      compiled = compiler.compile({ text: plan.text, language: plan.locale })
    } catch (error) {
      throw new Error(
        `Unable to compile ${JSON.stringify(plan.text)} (${plan.locale}) from ${relative(loaded.root, plan.sourceFont.file)} to ${relative(loaded.root, plan.targetFont.file)}`,
        { cause: error },
      )
    }
    sdfMorphs[plan.key] = {
      sourceRun: compiled.sourceRun,
      targetRun: compiled.targetRun,
      glyphs: Object.fromEntries(
        Object.entries(compiled.glyphs).map(([key, glyph]) => [key, serializeGlyph(glyph)]),
      ),
    }
  }

  const manifests: GlyphfluxBuildResult['manifests'] = []
  for (const { locale, texts } of localeTexts) {
    const localeText = new Set(texts)
    const manifestOutlines = Object.fromEntries(
      Object.entries(outlines.outlines).filter(([key]) => localeText.has(JSON.parse(key)[0])),
    )
    const localeSdfMorphs = Object.fromEntries(
      Object.entries(sdfMorphs).filter(([key]) => localeText.has(JSON.parse(key)[0])),
    )
    const path = outputPath(loaded.config.output.manifests, locale, loaded.root)
    const contents = `${stableStringify({
      version: 2,
      outlines: manifestOutlines,
      sdfMorphs: localeSdfMorphs,
    })}\n`
    manifests.push({
      locale,
      path,
      bytes: await writeGenerated(path, contents, write),
    })
  }

  let runtimeModule: string | undefined
  if (loaded.config.output.runtimeModule) {
    runtimeModule = resolve(loaded.root, loaded.config.output.runtimeModule)
    const localeByText: Record<string, string> = {}
    for (const { locale, texts } of localeTexts) {
      for (const text of texts) localeByText[text] ??= locale
    }
    const exportName = loaded.config.output.runtimeExport ?? 'glyphfluxLocaleByText'
    await writeGenerated(
      runtimeModule,
      `// Generated by glyphflux build. Do not edit.\nexport const ${exportName}: Readonly<Record<string, string>> = ${stableStringify(localeByText, 2)}\n`,
      write,
    )
  }

  return {
    configPath: loaded.path,
    documents: discovered.files,
    locales: localeTexts.map(({ locale }) => locale),
    sourceTexts: discovered.sources,
    morphs: plans.length,
    manifests,
    ...(runtimeModule ? { runtimeModule } : {}),
  }
}
