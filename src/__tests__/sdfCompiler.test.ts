import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  compileSdfGlyphPair,
  compileSdfTextMorph,
  createSdfTextMorphCompiler,
  stableStringify,
} from '../compiler'
import {
  fontMorphSdfCoverageRamp,
  renderFontMorphSdfAlphaFrame,
  renderFontMorphSdfFrame,
} from '../sdf-runtime'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

async function font(name: string) {
  const bytes = await readFile(resolve(packageRoot, `demo/public/fonts/${name}`))
  return { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
}

function componentCount(field: ArrayLike<number>, size: number) {
  const visited = new Uint8Array(field.length)
  const minimumArea = Math.max(2, Math.floor((size * size) / 4096))
  let components = 0
  for (let start = 0; start < field.length; start += 1) {
    if (field[start] <= 128 || visited[start]) continue
    const queue = [start]
    visited[start] = 1
    let area = 0
    while (queue.length) {
      const index = queue.pop()!
      area += 1
      const x = index % size
      const y = Math.floor(index / size)
      for (const neighbor of [index - 1, index + 1, index - size, index + size]) {
        if (neighbor < 0 || neighbor >= field.length) continue
        const neighborX = neighbor % size
        const neighborY = Math.floor(neighbor / size)
        if (Math.abs(neighborX - x) + Math.abs(neighborY - y) !== 1) continue
        if (field[neighbor] > 128 && !visited[neighbor]) {
          visited[neighbor] = 1
          queue.push(neighbor)
        }
      }
    }
    if (area >= minimumArea) components += 1
  }
  return components
}

function holeCount(field: ArrayLike<number>, size: number) {
  const visited = new Uint8Array(field.length)
  const minimumArea = Math.max(2, Math.floor((size * size) / 4096))
  const queue: number[] = []
  const enqueue = (index: number) => {
    if (field[index] <= 128 && !visited[index]) {
      visited[index] = 1
      queue.push(index)
    }
  }
  for (let coordinate = 0; coordinate < size; coordinate += 1) {
    enqueue(coordinate)
    enqueue((size - 1) * size + coordinate)
    enqueue(coordinate * size)
    enqueue(coordinate * size + size - 1)
  }
  while (queue.length) {
    const index = queue.pop()!
    const x = index % size
    const y = Math.floor(index / size)
    for (const neighbor of [index - 1, index + 1, index - size, index + size]) {
      if (neighbor < 0 || neighbor >= field.length) continue
      const neighborX = neighbor % size
      const neighborY = Math.floor(neighbor / size)
      if (Math.abs(neighborX - x) + Math.abs(neighborY - y) !== 1) continue
      enqueue(neighbor)
    }
  }
  let holes = 0
  for (let start = 0; start < field.length; start += 1) {
    if (field[start] > 128 || visited[start]) continue
    let area = 0
    enqueue(start)
    while (queue.length) {
      const index = queue.pop()!
      area += 1
      const x = index % size
      const y = Math.floor(index / size)
      for (const neighbor of [index - 1, index + 1, index - size, index + size]) {
        if (neighbor < 0 || neighbor >= field.length) continue
        const neighborX = neighbor % size
        const neighborY = Math.floor(neighbor / size)
        if (Math.abs(neighborX - x) + Math.abs(neighborY - y) !== 1) continue
        enqueue(neighbor)
      }
    }
    if (area >= minimumArea) holes += 1
  }
  return holes
}

function inkMass(field: Uint8ClampedArray) {
  return field.reduce((total, alpha) => total + alpha / 255, 0)
}

describe('distance-field structural correspondence', () => {
  it('keeps spatial antialiasing near one physical pixel at different display scales', () => {
    const pair = { size: 128, maximumDistance: 64 }

    expect(fontMorphSdfCoverageRamp(pair, 64, 48, 1)).toBeCloseTo(11.90625)
    expect(fontMorphSdfCoverageRamp(pair, 64, 48, 3)).toBe(4)
    expect(fontMorphSdfCoverageRamp(pair, 32, 24, 1)).toBeCloseTo(23.8125)
    expect(fontMorphSdfCoverageRamp(pair, 256, 192, 1)).toBe(4)
  })

  it.each([
    {
      name: 'Arabic',
      text: 'بدخطي',
      language: 'ar',
      direction: 'rtl' as const,
      source: 'noto-sans-arabic-400-outline.ttf',
      target: 'noto-naskh-arabic-600-outline.ttf',
    },
    {
      name: 'Devanagari',
      text: 'उपवर्ण',
      language: 'hi',
      direction: 'ltr' as const,
      source: 'noto-sans-devanagari-400-outline.ttf',
      target: 'noto-serif-devanagari-600-outline.ttf',
    },
  ])('compiles contextual $name text as shaped glyphs', async (sample) => {
    const request = {
      text: sample.text,
      language: sample.language,
      direction: sample.direction,
    }
    const options = { size: 64, pixelsPerEm: 256, maximumDistance: 24, supersampling: 2 }
    const source = await font(sample.source)
    const target = await font(sample.target)
    const first = compileSdfTextMorph(source, target, request, options)
    const second = compileSdfTextMorph(source, target, request, options)

    expect(stableStringify(first)).toBe(stableStringify(second))
    expect(first.sourceRun.text).toBe(sample.text)
    expect(first.sourceRun.direction).toBe(sample.direction)
    expect(first.sourceRun.glyphs).toHaveLength(first.targetRun.glyphs.length)
    expect(first.sourceRun.glyphs.map(({ key }) => key)).toEqual(
      first.targetRun.glyphs.map(({ key }) => key),
    )
    for (const pair of Object.values(first.glyphs)) {
      expect(renderFontMorphSdfFrame(pair, 0)).toEqual(Float32Array.from(pair.source.distance))
      expect(renderFontMorphSdfFrame(pair, 1)).toEqual(Float32Array.from(pair.target.distance))
    }
  })

  it('compiles a complete shaped run when font substitutions have different counts', async () => {
    const morph = compileSdfTextMorph(
      await font('ibm-plex-sans-400-outline.ttf'),
      await font('source-serif-4-600-outline.ttf'),
      { text: 'ffi', language: 'en', direction: 'ltr' },
      { size: 64, pixelsPerEm: 256, maximumDistance: 24, supersampling: 2 },
    )

    expect(morph.sourceRun.glyphs).toHaveLength(1)
    expect(morph.targetRun.glyphs).toHaveLength(1)
    const key = morph.sourceRun.glyphs[0].key!
    expect(key).toMatch(/^run-/)
    expect(morph.targetRun.glyphs[0].key).toBe(key)
    expect(Object.keys(morph.glyphs)).toEqual([key])
    const pair = morph.glyphs[key]
    expect(renderFontMorphSdfFrame(pair, 0)).toEqual(Float32Array.from(pair.source.distance))
    expect(renderFontMorphSdfFrame(pair, 1)).toEqual(Float32Array.from(pair.target.distance))
  })

  it('reuses exact glyph correspondence across text runs for one font pair', async () => {
    const compiler = createSdfTextMorphCompiler(
      await font('ibm-plex-sans-400-outline.ttf'),
      await font('source-serif-4-600-outline.ttf'),
      { size: 64, pixelsPerEm: 256, maximumDistance: 24, supersampling: 2 },
    )
    const english = compiler.compile({ text: 'Allograph', language: 'en', direction: 'ltr' })
    const spanish = compiler.compile({ text: 'Alógrafo', language: 'es', direction: 'ltr' })
    const repeatedKey = english.sourceRun.glyphs[1].key!
    const sharedKey = english.sourceRun.glyphs[0].key!

    expect(english.sourceRun.glyphs[2].key).toBe(repeatedKey)
    expect(Object.keys(english.glyphs)).toHaveLength(8)
    expect(spanish.sourceRun.glyphs[0].key).toBe(sharedKey)
    expect(spanish.glyphs[sharedKey]).toBe(english.glyphs[sharedKey])
  })

  it('discovers deterministic local registration and prevents a transient split', async () => {
    const source = await font('noto-sans-jp-400-outline.ttf')
    const target = await font('noto-serif-jp-600-outline.ttf')
    const options = {
      size: 256,
      pixelsPerEm: 1024,
      maximumDistance: 64,
      supersampling: 4,
    }
    const started = performance.now()
    const first = compileSdfGlyphPair(source, target, '歴', options)
    const second = compileSdfGlyphPair(source, target, '歴', options)
    expect(performance.now() - started).toBeLessThan(4_000)
    expect(stableStringify(first)).toBe(stableStringify(second))
    expect(first.warpRegions.length).toBeGreaterThan(0)
    expect(first.warpRegions.every(({ id }) => id.startsWith('auto-'))).toBe(true)

    expect(renderFontMorphSdfFrame(first, 0)).toEqual(Float32Array.from(first.source.distance))
    expect(renderFontMorphSdfFrame(first, 1)).toEqual(Float32Array.from(first.target.distance))
    const endpointMaximum = Math.max(
      componentCount(renderFontMorphSdfAlphaFrame(first, 0), first.size),
      componentCount(renderFontMorphSdfAlphaFrame(first, 1), first.size),
    )
    const withoutRegistration = { ...first, warpRegions: [] }
    expect(
      componentCount(renderFontMorphSdfAlphaFrame(withoutRegistration, 0.5), first.size),
    ).toBeGreaterThan(endpointMaximum)
    expect(
      componentCount(renderFontMorphSdfAlphaFrame(first, 0.5), first.size),
    ).toBeLessThanOrEqual(endpointMaximum)
    expect(renderFontMorphSdfFrame(first, 0.37)).toEqual(renderFontMorphSdfFrame(first, 0.37))
  })

  it('allows legitimate component changes without cutting a persistent counter boundary', async () => {
    const pair = compileSdfGlyphPair(
      await font('noto-sans-tc-400-outline.ttf'),
      await font('noto-serif-tc-600-outline.ttf'),
      '異',
      { size: 128, pixelsPerEm: 512, maximumDistance: 48, supersampling: 2 },
    )
    const sourceComponents = componentCount(renderFontMorphSdfAlphaFrame(pair, 0), pair.size)
    const targetComponents = componentCount(renderFontMorphSdfAlphaFrame(pair, 1), pair.size)
    const sourceHoles = holeCount(renderFontMorphSdfAlphaFrame(pair, 0), pair.size)
    const targetHoles = holeCount(renderFontMorphSdfAlphaFrame(pair, 1), pair.size)
    const midpoint = renderFontMorphSdfAlphaFrame(pair, 0.5)

    expect(componentCount(midpoint, pair.size)).toBeLessThan(
      Math.min(sourceComponents, targetComponents),
    )
    expect(holeCount(midpoint, pair.size)).toBeGreaterThanOrEqual(
      Math.min(sourceHoles, targetHoles),
    )
    expect(holeCount(midpoint, pair.size)).toBeLessThanOrEqual(Math.max(sourceHoles, targetHoles))
    expect(pair.warpRegions).toEqual([])
  })

  it('preserves a stable counter without artificial topology', async () => {
    const pair = compileSdfGlyphPair(
      await font('ibm-plex-sans-400-outline.ttf'),
      await font('source-serif-4-600-outline.ttf'),
      'R',
      { size: 64, pixelsPerEm: 256, maximumDistance: 24, supersampling: 2 },
    )
    expect(pair.warpRegions).toEqual([])
    for (const progress of [0, 0.01, 0.125, 0.25, 0.5, 0.75, 0.875, 0.99, 1]) {
      expect(holeCount(renderFontMorphSdfAlphaFrame(pair, progress), pair.size)).toBe(1)
    }
  })

  it('keeps a connected stem morph optically balanced instead of dilating it', async () => {
    const pair = compileSdfGlyphPair(
      await font('ibm-plex-sans-400-outline.ttf'),
      await font('source-serif-4-600-outline.ttf'),
      'h',
      { size: 128, pixelsPerEm: 512, maximumDistance: 48, supersampling: 2 },
    )
    const sourceMass = inkMass(renderFontMorphSdfAlphaFrame(pair, 0))
    const targetMass = inkMass(renderFontMorphSdfAlphaFrame(pair, 1))
    const endpointMaximum = Math.max(
      componentCount(renderFontMorphSdfAlphaFrame(pair, 0), pair.size),
      componentCount(renderFontMorphSdfAlphaFrame(pair, 1), pair.size),
    )

    for (const progress of [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]) {
      const expectedMass = sourceMass + (targetMass - sourceMass) * progress
      const actualMass = inkMass(renderFontMorphSdfAlphaFrame(pair, progress))
      expect(actualMass / expectedMass).toBeGreaterThan(0.9)
      expect(actualMass / expectedMass).toBeLessThan(1.1)
      expect(
        componentCount(renderFontMorphSdfAlphaFrame(pair, progress), pair.size),
      ).toBeLessThanOrEqual(endpointMaximum)
    }
  })

  it('does not phase source-only and target-only coverage through intermediate opacity', () => {
    const pair = {
      unicode: 'x',
      size: 1,
      source: { fontInstanceId: 'source', glyphId: 1, distance: Uint8Array.of(0) },
      target: { fontInstanceId: 'target', glyphId: 1, distance: Uint8Array.of(255) },
      warpRegions: [],
    }

    expect(renderFontMorphSdfAlphaFrame(pair, 0)).toEqual(Uint8ClampedArray.of(0))
    const early = renderFontMorphSdfAlphaFrame(pair, 0.25)[0]
    const middle = renderFontMorphSdfAlphaFrame(pair, 0.5)[0]
    const late = renderFontMorphSdfAlphaFrame(pair, 0.75)[0]
    expect(early).toBe(0)
    expect(middle).toBeGreaterThan(0)
    expect(middle).toBeLessThan(255)
    expect(late).toBe(255)
    expect(renderFontMorphSdfAlphaFrame(pair, 1)).toEqual(Uint8ClampedArray.of(255))
  })

  it.each(['き', 'さ'])('allows legitimate connectivity changes for %s', async (unicode) => {
    const pair = compileSdfGlyphPair(
      await font('noto-sans-jp-400-outline.ttf'),
      await font('noto-serif-jp-600-outline.ttf'),
      unicode,
      { size: 128, pixelsPerEm: 512, maximumDistance: 48, supersampling: 2 },
    )
    const endpointComponents = [
      componentCount(renderFontMorphSdfAlphaFrame(pair, 0), pair.size),
      componentCount(renderFontMorphSdfAlphaFrame(pair, 1), pair.size),
    ]
    const endpointHoles = [
      holeCount(renderFontMorphSdfAlphaFrame(pair, 0), pair.size),
      holeCount(renderFontMorphSdfAlphaFrame(pair, 1), pair.size),
    ]
    for (const progress of [0.125, 0.25, 0.5, 0.75, 0.875]) {
      const frame = renderFontMorphSdfAlphaFrame(pair, progress)
      expect(componentCount(frame, pair.size)).toBeGreaterThanOrEqual(
        Math.min(...endpointComponents),
      )
      expect(componentCount(frame, pair.size)).toBeLessThanOrEqual(Math.max(...endpointComponents))
      expect(holeCount(frame, pair.size)).toBeGreaterThanOrEqual(Math.min(...endpointHoles))
      expect(holeCount(frame, pair.size)).toBeLessThanOrEqual(Math.max(...endpointHoles))
    }
  })
})
