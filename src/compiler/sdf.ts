import type { FontMorphCompiledRun, FontMorphShapedGlyph } from '../contracts/font'
import type {
  FontMorphCompiledSdfMorph,
  FontMorphSdfEndpoint,
  FontMorphSdfGlyphPair,
} from '../contracts/sdf'
import { glyphDistanceField } from './distanceField'
import type { FontMorphFontInput } from './fontIdentity'
import {
  extractFontMorphInstantiatedGlyph,
  extractFontMorphInstantiatedGlyphById,
  extractFontMorphInstantiatedRun,
  type FontMorphExtractedGlyph,
} from './outline'
import { parseFontMorphFont, type ParsedFontMorphFont } from './fontParser'
import { rasterizeFontMorphGlyph, type FontMorphRaster } from './rasterize'
import { discoverSdfWarpRegions } from './sdfCorrespondence'
import {
  shapeFontMorphInstantiatedRun,
  type FontMorphRunShaper,
  type FontMorphShapeRequest,
} from './shaping'

export interface FontMorphSdfCompileOptions {
  size?: number
  pixelsPerEm?: number
  maximumDistance?: number
  supersampling?: number
  /** Transparent field pixels retained around every glyph. */
  texturePadding?: number
  /** Optional deterministic shaper, such as HarfBuzz, for complex scripts. */
  shaper?: FontMorphRunShaper
}

export type FontMorphSdfTextRequest = Omit<FontMorphShapeRequest, 'fontInstanceId'>

export interface FontMorphSdfTextCompiler {
  readonly sourceFontInstanceId: string
  readonly targetFontInstanceId: string
  compile(request: FontMorphSdfTextRequest): FontMorphCompiledSdfMorph
}

interface ResolvedSdfCompileOptions {
  size: number
  pixelsPerEm: number
  maximumDistance: number
  supersampling: number
  texturePadding: number
}

function fixedMask(
  raster: FontMorphRaster,
  size: number,
  supersampling: number,
  texturePadding: number,
) {
  const output = new Uint8Array(size * size)
  const innerSize = size - texturePadding * 2
  const sampleTotal = supersampling * supersampling
  for (let row = texturePadding; row < size - texturePadding; row += 1) {
    for (let column = texturePadding; column < size - texturePadding; column += 1) {
      let coverage = 0
      for (let sampleY = 0; sampleY < supersampling; sampleY += 1) {
        const y =
          ((row - texturePadding + (sampleY + 0.5) / supersampling) / innerSize) * raster.height
        const sourceRow = Math.min(raster.height - 1, Math.floor(y))
        for (let sampleX = 0; sampleX < supersampling; sampleX += 1) {
          const x =
            ((column - texturePadding + (sampleX + 0.5) / supersampling) / innerSize) * raster.width
          const sourceColumn = Math.min(raster.width - 1, Math.floor(x))
          coverage += raster.data[sourceRow * raster.width + sourceColumn]
        }
      }
      output[row * size + column] = coverage * 2 >= sampleTotal ? 1 : 0
    }
  }
  return output
}

function paddedBounds(raster: FontMorphRaster, size: number, texturePadding: number) {
  const innerSize = size - texturePadding * 2
  const xPadding = ((raster.bounds.xMax - raster.bounds.xMin) * texturePadding) / innerSize
  const yPadding = ((raster.bounds.yMax - raster.bounds.yMin) * texturePadding) / innerSize
  return {
    xMin: raster.bounds.xMin - xPadding,
    yMin: raster.bounds.yMin - yPadding,
    xMax: raster.bounds.xMax + xPadding,
    yMax: raster.bounds.yMax + yPadding,
  }
}

function encodedSignedDistance(data: Uint8Array, size: number, maximumDistance: number) {
  const raster: FontMorphRaster = {
    width: size,
    height: size,
    pixelsPerEm: size,
    bounds: { xMin: 0, yMin: 0, xMax: 1, yMax: 1 },
    data,
  }
  const inside = glyphDistanceField(raster)
  const inverse = Uint8Array.from(data, (value) => (value ? 0 : 1))
  const outside = glyphDistanceField({ ...raster, data: inverse })
  const output = new Uint8Array(data.length)
  for (let index = 0; index < output.length; index += 1) {
    const signed = data[index] ? inside[index] : -outside[index]
    const normalized = Math.max(-1, Math.min(1, signed / maximumDistance))
    output[index] = Math.max(0, Math.min(255, Math.round(128 + normalized * 127)))
  }
  return output
}

function compileExtractedEndpoint(
  parsed: ParsedFontMorphFont,
  outline: FontMorphExtractedGlyph,
  size: number,
  pixelsPerEm: number,
  maximumDistance: number,
  supersampling: number,
  texturePadding: number,
): FontMorphSdfEndpoint {
  const raster = rasterizeFontMorphGlyph(outline, pixelsPerEm)
  return {
    fontInstanceId: parsed.instance.id,
    glyphId: outline.glyphId,
    advanceWidth: outline.advanceWidth,
    textureBounds: paddedBounds(raster, size, texturePadding),
    distance: encodedSignedDistance(
      fixedMask(raster, size, supersampling, texturePadding),
      size,
      maximumDistance,
    ),
  }
}

function compileEndpoint(
  parsed: ParsedFontMorphFont,
  unicode: string,
  options: ResolvedSdfCompileOptions,
) {
  const codePoints = [...unicode].map((character) => character.codePointAt(0)!)
  if (codePoints.length !== 1) {
    throw new RangeError('Glyphflux distance fields compile one Unicode character at a time')
  }
  return compileExtractedEndpoint(
    parsed,
    extractFontMorphInstantiatedGlyph(parsed.outlineFont, codePoints[0], 1 / options.pixelsPerEm),
    options.size,
    options.pixelsPerEm,
    options.maximumDistance,
    options.supersampling,
    options.texturePadding,
  )
}

function compileGlyphEndpoint(
  parsed: ParsedFontMorphFont,
  glyphId: number,
  options: ResolvedSdfCompileOptions,
) {
  return compileExtractedEndpoint(
    parsed,
    extractFontMorphInstantiatedGlyphById(parsed.outlineFont, glyphId, 1 / options.pixelsPerEm),
    options.size,
    options.pixelsPerEm,
    options.maximumDistance,
    options.supersampling,
    options.texturePadding,
  )
}

function resolvedOptions(options: FontMorphSdfCompileOptions): ResolvedSdfCompileOptions {
  const size = options.size ?? 256
  const pixelsPerEm = options.pixelsPerEm ?? 1024
  const maximumDistance = options.maximumDistance ?? 48
  const supersampling = options.supersampling ?? 4
  const texturePadding = options.texturePadding ?? Math.max(2, Math.ceil(size / 64))
  if (!Number.isSafeInteger(size) || size < 32 || size > 1024) {
    throw new RangeError('Glyphflux distance-field size must be an integer from 32 through 1024')
  }
  if (!Number.isSafeInteger(pixelsPerEm) || pixelsPerEm < 16 || pixelsPerEm > 4096) {
    throw new RangeError('Glyphflux pixelsPerEm must be an integer from 16 through 4096')
  }
  if (!Number.isSafeInteger(supersampling) || supersampling < 1 || supersampling > 8) {
    throw new RangeError(
      'Glyphflux distance-field supersampling must be an integer from 1 through 8',
    )
  }
  if (!Number.isSafeInteger(texturePadding) || texturePadding < 1 || texturePadding * 4 >= size) {
    throw new RangeError(
      'Glyphflux texture padding must be a positive integer below one quarter of field size',
    )
  }
  if (!Number.isFinite(maximumDistance) || maximumDistance <= 0 || maximumDistance > 0xffff) {
    throw new RangeError('Glyphflux maximum distance must be positive')
  }
  return { size, pixelsPerEm, maximumDistance, supersampling, texturePadding }
}

function compilePair(
  key: string,
  unicode: string,
  source: FontMorphSdfEndpoint,
  target: FontMorphSdfEndpoint,
  options: ResolvedSdfCompileOptions,
) {
  const pair: FontMorphSdfGlyphPair = {
    key,
    unicode,
    size: options.size,
    maximumDistance: options.maximumDistance,
    warpRegions: [],
    source,
    target,
  }
  pair.warpRegions = discoverSdfWarpRegions(pair)
  return pair
}

export function compileSdfGlyphPair(
  source: FontMorphFontInput,
  target: FontMorphFontInput,
  unicode: string,
  options: FontMorphSdfCompileOptions = {},
): FontMorphSdfGlyphPair {
  return compileSdfGlyphPairs(source, target, [unicode], options)[0]
}

export function compileSdfGlyphPairs(
  source: FontMorphFontInput,
  target: FontMorphFontInput,
  characters: readonly string[],
  options: FontMorphSdfCompileOptions = {},
): FontMorphSdfGlyphPair[] {
  if (characters.some((unicode) => [...unicode].length !== 1)) {
    throw new RangeError('Glyphflux distance fields compile one Unicode character at a time')
  }
  const resolved = resolvedOptions(options)
  const sourceParsed = parseFontMorphFont(source)
  const targetParsed = parseFontMorphFont(target)
  return [...new Set(characters)].sort().map((unicode) => {
    return compilePair(
      unicode,
      unicode,
      compileEndpoint(sourceParsed, unicode, resolved),
      compileEndpoint(targetParsed, unicode, resolved),
      resolved,
    )
  })
}

function collapsedRun(run: FontMorphCompiledRun, key: string): FontMorphCompiledRun {
  const glyph: FontMorphShapedGlyph = {
    key,
    codePoints: [...run.text].map((character) => character.codePointAt(0)!),
    unicode: run.text,
    glyphId: -1,
    x: 0,
    y: 0,
    advanceWidth: run.advanceWidth,
  }
  return { ...run, glyphs: [glyph] }
}

interface ShapedCluster {
  cluster: number
  unicode: string
  codePoints: number[]
  x: number
  y: number
  advanceWidth: number
  run: FontMorphCompiledRun
}

function shapedClusters(run: FontMorphCompiledRun): ShapedCluster[] | undefined {
  if (run.glyphs.some(({ cluster }) => cluster === undefined)) return undefined
  const groups = new Map<
    number,
    {
      cluster: number
      unicode: string
      codePoints: number[]
      x: number
      y: number
      advanceWidth: number
      glyphs: FontMorphShapedGlyph[]
    }
  >()
  let penX = 0
  for (const glyph of run.glyphs) {
    const cluster = glyph.cluster!
    let group = groups.get(cluster)
    if (!group) {
      group = {
        cluster,
        unicode: '',
        codePoints: [],
        x: penX,
        y: 0,
        advanceWidth: 0,
        glyphs: [],
      }
      groups.set(cluster, group)
    }
    if (glyph.unicode && !group.unicode) {
      group.unicode = glyph.unicode
      group.codePoints = glyph.codePoints
    }
    group.glyphs.push({ ...glyph, x: glyph.x - group.x, y: glyph.y - group.y })
    group.advanceWidth += glyph.advanceWidth
    penX += glyph.advanceWidth
  }
  return [...groups.values()].map((group) => ({
    ...group,
    run: {
      ...run,
      text: group.unicode,
      glyphs: group.glyphs,
      advanceWidth: group.advanceWidth,
    },
  }))
}

function collapsedCluster(cluster: ShapedCluster, key: string): FontMorphShapedGlyph {
  return {
    key,
    codePoints: cluster.codePoints,
    unicode: cluster.unicode,
    cluster: cluster.cluster,
    glyphId: -1,
    x: cluster.x,
    y: cluster.y,
    advanceWidth: cluster.advanceWidth,
  }
}

/**
 * Shapes the same text in both fonts and compiles the exact contextual glyphs.
 * Visual-order glyphs are paired when possible. If the fonts substitute a
 * different number of glyphs, the complete shaped runs become one deterministic
 * correspondence unit rather than guessing a character-level mapping.
 */
export function compileSdfTextMorph(
  source: FontMorphFontInput,
  target: FontMorphFontInput,
  request: FontMorphSdfTextRequest,
  options: FontMorphSdfCompileOptions = {},
): FontMorphCompiledSdfMorph {
  return createSdfTextMorphCompiler(source, target, options).compile(request)
}

/**
 * Creates a compiler scoped to one exact font-instance pair. Parsed fonts,
 * endpoint fields, and glyph correspondences are reused across text runs.
 * Reuse changes neither field resolution nor correspondence quality.
 */
export function createSdfTextMorphCompiler(
  source: FontMorphFontInput,
  target: FontMorphFontInput,
  options: FontMorphSdfCompileOptions = {},
): FontMorphSdfTextCompiler {
  const resolved = resolvedOptions(options)
  const sourceParsed = parseFontMorphFont(source)
  const targetParsed = parseFontMorphFont(target)
  const sourceEndpoints = new Map<number, FontMorphSdfEndpoint>()
  const targetEndpoints = new Map<number, FontMorphSdfEndpoint>()
  const glyphPairs = new Map<string, FontMorphSdfGlyphPair>()
  const runPairs = new Map<string, FontMorphSdfGlyphPair>()

  const endpoint = (
    parsed: ParsedFontMorphFont,
    glyphId: number,
    cache: Map<number, FontMorphSdfEndpoint>,
    outline?: FontMorphExtractedGlyph,
  ) => {
    let compiled = cache.get(glyphId)
    if (!compiled) {
      compiled = outline
        ? compileExtractedEndpoint(
            parsed,
            outline,
            resolved.size,
            resolved.pixelsPerEm,
            resolved.maximumDistance,
            resolved.supersampling,
            resolved.texturePadding,
          )
        : compileGlyphEndpoint(parsed, glyphId, resolved)
      cache.set(glyphId, compiled)
    }
    return compiled
  }

  const compile = (request: FontMorphSdfTextRequest): FontMorphCompiledSdfMorph => {
    const sourceRequest = { ...request, fontInstanceId: sourceParsed.instance.id }
    const targetRequest = { ...request, fontInstanceId: targetParsed.instance.id }
    let sourceRun = options.shaper
      ? options.shaper(source, sourceRequest)
      : shapeFontMorphInstantiatedRun(sourceParsed.outlineFont, sourceRequest)
    let targetRun = options.shaper
      ? options.shaper(target, targetRequest)
      : shapeFontMorphInstantiatedRun(targetParsed.outlineFont, targetRequest)
    const glyphs: Record<string, FontMorphSdfGlyphPair> = {}

    const signatureNumber = (value: number) => {
      const rounded = Math.abs(value) < 1e-12 ? 0 : Number(value.toFixed(12))
      return String(rounded)
    }
    // The contextual advance belongs to the shaped layout, not to the glyph
    // geometry. Excluding it lets identical cluster outlines reuse one field
    // even when kerning changes their following advance.
    const runSignature = (run: FontMorphCompiledRun) =>
      run.glyphs
        .map(({ glyphId, x, y }) =>
          [glyphId.toString(36), signatureNumber(x), signatureNumber(y)].join('_'),
        )
        .join('.')
    const compileRunUnit = (
      sourceUnit: FontMorphCompiledRun,
      targetUnit: FontMorphCompiledRun,
      unicode: string,
      prefix: string,
    ) => {
      const signature = `${runSignature(sourceUnit)}-${runSignature(targetUnit)}`
      const key = `${prefix}-${signature}`
      let pair = runPairs.get(key)
      if (!pair) {
        const sourceOutline = extractFontMorphInstantiatedRun(
          sourceParsed.outlineFont,
          sourceUnit,
        )
        const targetOutline = extractFontMorphInstantiatedRun(
          targetParsed.outlineFont,
          targetUnit,
        )
        pair = compilePair(
          key,
          unicode,
          compileExtractedEndpoint(
            sourceParsed,
            sourceOutline,
            resolved.size,
            resolved.pixelsPerEm,
            resolved.maximumDistance,
            resolved.supersampling,
            resolved.texturePadding,
          ),
          compileExtractedEndpoint(
            targetParsed,
            targetOutline,
            resolved.size,
            resolved.pixelsPerEm,
            resolved.maximumDistance,
            resolved.supersampling,
            resolved.texturePadding,
          ),
          resolved,
        )
        runPairs.set(key, pair)
      }
      glyphs[key] = pair
      return key
    }

    const sourceClusters = shapedClusters(sourceRun)
    const targetClusters = shapedClusters(targetRun)
    if (sourceClusters && targetClusters) {
      const targetByCluster = new Map(targetClusters.map((cluster) => [cluster.cluster, cluster]))
      if (
        sourceClusters.length === targetClusters.length &&
        sourceClusters.every(({ cluster }) => targetByCluster.has(cluster))
      ) {
        const sourceGlyphs: FontMorphShapedGlyph[] = []
        const targetGlyphs: FontMorphShapedGlyph[] = []
        for (const sourceCluster of sourceClusters) {
          const targetCluster = targetByCluster.get(sourceCluster.cluster)!
          const key = compileRunUnit(
            sourceCluster.run,
            targetCluster.run,
            sourceCluster.unicode || targetCluster.unicode,
            'cluster',
          )
          sourceGlyphs.push(collapsedCluster(sourceCluster, key))
          targetGlyphs.push(collapsedCluster(targetCluster, key))
        }
        sourceRun = { ...sourceRun, glyphs: sourceGlyphs }
        targetRun = { ...targetRun, glyphs: targetGlyphs }
        return { sourceRun, targetRun, glyphs }
      }
    }

    if (sourceRun.glyphs.length !== targetRun.glyphs.length) {
      const key = compileRunUnit(sourceRun, targetRun, request.text, 'run')
      sourceRun = collapsedRun(sourceRun, key)
      targetRun = collapsedRun(targetRun, key)
      return { sourceRun, targetRun, glyphs }
    }

    for (let index = 0; index < sourceRun.glyphs.length; index += 1) {
      const sourceGlyph = sourceRun.glyphs[index]
      const targetGlyph = targetRun.glyphs[index]
      const key = `glyph-${sourceGlyph.glyphId.toString(36)}-${targetGlyph.glyphId.toString(36)}`
      sourceGlyph.key = key
      targetGlyph.key = key
      let pair = glyphPairs.get(key)
      if (!pair) {
        const sourceOutline = extractFontMorphInstantiatedGlyphById(
          sourceParsed.outlineFont,
          sourceGlyph.glyphId,
          1 / resolved.pixelsPerEm,
        )
        const targetOutline = extractFontMorphInstantiatedGlyphById(
          targetParsed.outlineFont,
          targetGlyph.glyphId,
          1 / resolved.pixelsPerEm,
        )
        if (!sourceOutline.contours.length && !targetOutline.contours.length) continue
        pair = compilePair(
          key,
          sourceGlyph.unicode || targetGlyph.unicode,
          endpoint(sourceParsed, sourceGlyph.glyphId, sourceEndpoints, sourceOutline),
          endpoint(targetParsed, targetGlyph.glyphId, targetEndpoints, targetOutline),
          resolved,
        )
        glyphPairs.set(key, pair)
      }
      glyphs[key] = pair
    }
    return { sourceRun, targetRun, glyphs }
  }

  return {
    sourceFontInstanceId: sourceParsed.instance.id,
    targetFontInstanceId: targetParsed.instance.id,
    compile,
  }
}
