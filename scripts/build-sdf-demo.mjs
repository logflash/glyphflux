import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fontMorphPreparedKey } from '../dist/index.mjs'
import {
  createSdfTextMorphCompiler,
  stableStringify,
} from '../dist/compiler/index.mjs'
import { createHarfBuzzRunShaper } from '../dist/build/index.mjs'

const started = performance.now()
const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const outputDirectory = resolve(packageRoot, 'demo/public/generated')
const catalog = JSON.parse(await readFile(resolve(packageRoot, 'demo/catalog.json'), 'utf8'))
const samples = Object.fromEntries(
  catalog.languages.map((language) => {
    const profile = catalog.profiles[language.profile]
    if (!profile) throw new Error(`Unknown profile ${language.profile} for ${language.code}`)
    return [
      language.code,
      {
        label: language.label,
        text: language.text,
        language: language.language ?? language.code,
        sourceLabel: profile.sourceLabel,
        targetLabel: profile.targetLabel,
        direction: language.direction,
        pair: language.profile,
      },
    ]
  }),
)
if (Object.keys(samples).length !== catalog.languages.length) {
  throw new Error('Demo language codes must be unique')
}
const pairFiles = Object.fromEntries(
  Object.entries(catalog.profiles).map(([id, profile]) => [
    id,
    [
      { file: profile.sourceFile, axes: profile.sourceAxes },
      { file: profile.targetFile, axes: profile.targetAxes },
    ],
  ]),
)
const shaper = createHarfBuzzRunShaper()
const readFont = async ({ file, axes }) => {
  const bytes = await readFile(resolve(packageRoot, 'demo/public/fonts', file))
  return {
    data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    ...(axes ? { axes } : {}),
  }
}
const pairs = {}
for (const [profileIndex, [id, [sourceSpec, targetSpec]]] of Object.entries(pairFiles).entries()) {
  const source = await readFont(sourceSpec)
  const target = await readFont(targetSpec)
  const matchingSamples = Object.values(samples).filter((candidate) => candidate.pair === id)
  if (!matchingSamples.length) throw new Error(`Missing sample for ${id}`)
  let compiler
  try {
    compiler = createSdfTextMorphCompiler(source, target, {
      size: 256,
      pixelsPerEm: 1024,
      maximumDistance: 64,
      supersampling: 4,
      shaper,
    })
  } catch (error) {
    throw new Error(`Unable to initialize Glyphflux demo profile ${id}`, { cause: error })
  }
  const glyphs = {}
  for (const sample of matchingSamples) {
    let morph
    try {
      morph = compiler.compile({
        text: sample.text,
        language: sample.language,
        direction: sample.direction,
      })
    } catch (error) {
      throw new Error(
        `Unable to compile Glyphflux demo sample ${sample.label} (${sample.language}) with profile ${id}`,
        { cause: error },
      )
    }
    Object.assign(glyphs, morph.glyphs)
    sample.sourceRun = morph.sourceRun
    sample.targetRun = morph.targetRun
    sample.preparedKey = fontMorphPreparedKey(
      sample.text,
      {
        role: 'sans',
        weight: sourceSpec.axes?.wght ?? 400,
        opticalSize: 0,
        fontFileIndex: profileIndex,
      },
      {
        role: 'serif',
        weight: targetSpec.axes?.wght ?? 600,
        opticalSize: targetSpec.axes?.opsz ?? 0,
        fontFileIndex: profileIndex,
      },
    )
  }
  pairs[id] = {
    sourceFontInstanceId: compiler.sourceFontInstanceId,
    targetFontInstanceId: compiler.targetFontInstanceId,
    glyphs: Object.fromEntries(
      Object.entries(glyphs).map(([key, glyph]) => [
        key,
        {
          ...glyph,
          source: {
            ...glyph.source,
            distanceBase64: Buffer.from(glyph.source.distance).toString('base64'),
            distance: undefined,
          },
          target: {
            ...glyph.target,
            distanceBase64: Buffer.from(glyph.target.distance).toString('base64'),
            distance: undefined,
          },
        },
      ]),
    ),
  }
}

await rm(resolve(outputDirectory, 'sdf.json'), { force: true })
await mkdir(resolve(outputDirectory, 'pairs'), { recursive: true })
const manifest = `${stableStringify(
  {
    version: 2,
    languageOrder: catalog.languages.map(({ code }) => code),
    samples,
    pairIds: Object.keys(pairs).sort(),
  },
  2,
)}\n`
await writeFile(resolve(outputDirectory, 'manifest.json'), manifest)
let byteLength = Buffer.byteLength(manifest)
for (const [id, pair] of Object.entries(pairs)) {
  const serialized = `${stableStringify({ version: 1, ...pair }, 2)}\n`
  await writeFile(resolve(outputDirectory, 'pairs', `${id}.json`), serialized)
  byteLength += Buffer.byteLength(serialized)
}
console.log(
  `wrote ${(byteLength / 1_000_000).toFixed(2)} MB of distance-field demo data to ${outputDirectory} in ${(performance.now() - started).toFixed(1)}ms`,
)
