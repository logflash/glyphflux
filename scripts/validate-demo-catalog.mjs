import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { create as createFontkit } from 'fontkit'
import * as harfbuzz from 'harfbuzzjs'
import { createHarfBuzzRunShaper } from '../dist/build/index.mjs'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const catalog = JSON.parse(await readFile(resolve(packageRoot, 'demo/catalog.json'), 'utf8'))
const fixtures = JSON.parse(
  await readFile(resolve(packageRoot, 'demo/regression-fixtures.json'), 'utf8'),
)
const terminology = JSON.parse(
  await readFile(resolve(packageRoot, 'demo/terminology.json'), 'utf8'),
)
const classifiedCodes = Object.values(terminology).flat()
const languageCodes = catalog.languages.map(({ code }) => code)

assert.equal(new Set(languageCodes).size, languageCodes.length, 'language codes must be unique')
assert.deepEqual(
  [...classifiedCodes].sort(),
  [...languageCodes].sort(),
  'every language must have exactly one terminology source category',
)

const fileCache = new Map()
const readFont = async (file, axes) => {
  let data = fileCache.get(file)
  if (!data) {
    const bytes = await readFile(resolve(packageRoot, 'demo/public/fonts', file))
    data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    fileCache.set(file, data)
  }
  return { data, ...(axes ? { axes } : {}) }
}
const unicodeCache = new Map()
const axisCache = new Map()
const variationAxesFor = async (file) => {
  let axes = axisCache.get(file)
  if (!axes) {
    const input = await readFont(file)
    axes = createFontkit(new Uint8Array(input.data)).variationAxes ?? {}
    axisCache.set(file, axes)
  }
  return axes
}
const unicodesFor = async (file) => {
  let unicodes = unicodeCache.get(file)
  if (!unicodes) {
    const input = await readFont(file)
    const blob = new harfbuzz.Blob(new Uint8Array(input.data))
    const face = new harfbuzz.Face(blob)
    unicodes = new Set(face.collectUnicodes())
    unicodeCache.set(file, unicodes)
  }
  return unicodes
}

const familyFiles = new Map()
for (const [profileId, profile] of Object.entries(catalog.profiles)) {
  for (const side of ['source', 'target']) {
    const file = profile[`${side}File`]
    const family = profile[`${side}Family`]
    const priorFile = familyFiles.get(family)
    assert(
      !priorFile || priorFile === file,
      `${profileId}.${side}Family ${JSON.stringify(family)} aliases both ${priorFile} and ${file}`,
    )
    familyFiles.set(family, file)
    const declared = profile[`${side}Axes`] ?? {}
    const available = await variationAxesFor(file)
    if (available.wght) {
      assert.notEqual(
        declared.wght,
        undefined,
        `${profileId}.${side}Axes.wght must declare the variable-font instance rendered by CSS`,
      )
    }
    for (const [tag, value] of Object.entries(declared)) {
      const axis = available[tag]
      if (axis) {
        assert(
          value >= axis.min && value <= axis.max,
          `${profileId}.${side}Axes.${tag} must be within ${axis.min}..${axis.max}`,
        )
      }
    }
  }
}

const samples = [...catalog.languages, ...fixtures]
const shaper = createHarfBuzzRunShaper()
for (const sample of samples) {
  assert.equal(sample.text, sample.text.trim(), `${sample.code ?? sample.id}: text must be trimmed`)
  assert(sample.text.length > 0, `${sample.code ?? sample.id}: text must not be empty`)
  if (sample.label) {
    assert.notEqual(
      sample.text.toLocaleLowerCase('und'),
      sample.label.toLocaleLowerCase('und'),
      `${sample.code}: sample text must not be its locale label`,
    )
  }
  const profile = catalog.profiles[sample.profile]
  assert(profile, `${sample.code ?? sample.id}: unknown profile ${sample.profile}`)
  for (const file of [profile.sourceFile, profile.targetFile]) {
    const unicodes = await unicodesFor(file)
    for (const character of sample.text) {
      assert(
        unicodes.has(character.codePointAt(0)),
        `${sample.code ?? sample.id}: ${file} lacks authored coverage for ${JSON.stringify(character)}`,
      )
    }
  }
  const request = {
    text: sample.text,
    language: sample.language ?? sample.code ?? 'und',
    direction: sample.direction,
  }
  const source = await readFont(profile.sourceFile, profile.sourceAxes)
  const target = await readFont(profile.targetFile, profile.targetAxes)
  const sourceRun = shaper(source, { ...request, fontInstanceId: 'source' })
  const targetRun = shaper(target, { ...request, fontInstanceId: 'target' })
  assert(sourceRun.glyphs.length > 0, `${sample.code ?? sample.id}: empty source shaping run`)
  assert(targetRun.glyphs.length > 0, `${sample.code ?? sample.id}: empty target shaping run`)
  assert.equal(sourceRun.script, targetRun.script, `${sample.code ?? sample.id}: script mismatch`)
  assert.equal(sourceRun.direction, sample.direction, `${sample.code ?? sample.id}: source direction`)
  assert.equal(targetRun.direction, sample.direction, `${sample.code ?? sample.id}: target direction`)
}

console.log(
  `Validated ${catalog.languages.length} languages, ${fixtures.length} regression fixture, and ${fileCache.size} subset fonts`,
)
