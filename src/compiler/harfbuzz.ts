import { createHash } from 'node:crypto'
import * as harfbuzz from 'harfbuzzjs'
import type { FontMorphCompiledRun, FontMorphShapedGlyph } from '../contracts/font'
import { stableStringify } from '../contracts/stableJson'
import { createFontInstance, type FontMorphFontInput } from './fontIdentity'
import {
  resolveFontMorphShapeRequest,
  type FontMorphRunShaper,
  type FontMorphShapeRequest,
} from './shaping'

function fontBytes(data: ArrayBuffer | ArrayBufferView) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

function clusterText(text: string, infos: readonly { cluster: number }[]) {
  const starts = [...new Set(infos.map(({ cluster }) => cluster))].sort(
    (left, right) => left - right,
  )
  return new Map(
    starts.map((start, index) => [start, text.slice(start, starts[index + 1] ?? text.length)]),
  )
}

interface CachedHarfBuzzFont {
  blob: harfbuzz.Blob
  face: harfbuzz.Face
  font: harfbuzz.Font
}

/** Creates one synchronous, variation-aware HarfBuzz shaper for build tools. */
export function createHarfBuzzRunShaper(): FontMorphRunShaper {
  const fonts = new Map<string, CachedHarfBuzzFont>()

  return (input: FontMorphFontInput, request: FontMorphShapeRequest): FontMorphCompiledRun => {
    const identity = resolveFontMorphShapeRequest(request)
    const instance = createFontInstance(input)
    let cached = fonts.get(instance.id)
    if (!cached) {
      const blob = new harfbuzz.Blob(fontBytes(input.data))
      const face = new harfbuzz.Face(blob, instance.faceIndex)
      const font = new harfbuzz.Font(face)
      font.setScale(face.upem, face.upem)
      font.setVariations(
        Object.entries(instance.axes).map(([tag, value]) => new harfbuzz.Variation(tag, value)),
      )
      cached = { blob, face, font }
      fonts.set(instance.id, cached)
    }

    const buffer = new harfbuzz.Buffer()
    buffer.addText(identity.text)
    buffer.setScript(identity.script)
    buffer.setLanguage(identity.language)
    buffer.setDirection(
      identity.direction === 'rtl' ? harfbuzz.Direction.RTL : harfbuzz.Direction.LTR,
    )
    const features = Object.entries(identity.features).map(
      ([tag, enabled]) => new harfbuzz.Feature(tag, enabled ? 1 : 0),
    )
    harfbuzz.shape(cached.font, buffer, features)

    const infos = buffer.getGlyphInfos()
    const positions = buffer.getGlyphPositions()
    if (infos.length !== positions.length) {
      throw new Error('HarfBuzz returned inconsistent glyph and position counts')
    }
    const textByCluster = clusterText(identity.text, infos)
    const claimedClusters = new Set<number>()
    const glyphs: FontMorphShapedGlyph[] = []
    let x = 0
    let y = 0
    for (let index = 0; index < infos.length; index += 1) {
      const info = infos[index]
      const position = positions[index]
      const unicode = claimedClusters.has(info.cluster) ? '' : (textByCluster.get(info.cluster) ?? '')
      claimedClusters.add(info.cluster)
      const codePoints = [...unicode].map((character) => character.codePointAt(0)!)
      if (info.codepoint === 0 && codePoints.some((codePoint) => codePoint !== 0)) {
        throw new Error(`font does not contain ${JSON.stringify(unicode)}`)
      }
      glyphs.push({
        key: `glyph-${index.toString().padStart(4, '0')}`,
        codePoints,
        unicode,
        cluster: info.cluster,
        glyphId: info.codepoint,
        x: (x + position.xOffset) / cached.face.upem,
        y: (y + position.yOffset) / cached.face.upem,
        advanceWidth: position.xAdvance / cached.face.upem,
      })
      x += position.xAdvance
      y += position.yAdvance
    }

    return {
      id: `run-${createHash('sha256').update(stableStringify(identity)).digest('hex').slice(0, 16)}`,
      ...identity,
      glyphs,
      advanceWidth: x / cached.face.upem,
    }
  }
}
