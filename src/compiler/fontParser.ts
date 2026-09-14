import opentype, { type Font } from 'opentype.js'
import { create as createFontkit } from 'fontkit'
import { createFontInstance, fontArrayBuffer, type FontMorphFontInput } from './fontIdentity'

export interface FontMorphOutlinePathCommand {
  command: 'moveTo' | 'lineTo' | 'quadraticCurveTo' | 'bezierCurveTo' | 'closePath'
  args: number[]
}

export interface FontMorphOutlineGlyph {
  id: number
  codePoints: number[]
  advanceWidth: number
  path: { commands: FontMorphOutlinePathCommand[] }
}

export interface FontMorphOutlineGlyphPosition {
  xAdvance: number
  yAdvance: number
  xOffset: number
  yOffset: number
}

export interface FontMorphOutlineGlyphRun {
  glyphs: FontMorphOutlineGlyph[]
  positions: FontMorphOutlineGlyphPosition[]
  advanceWidth: number
  direction: 'ltr' | 'rtl'
  language: string | null
  script: string | string[]
}

export interface FontMorphOutlineFont {
  unitsPerEm: number
  glyphForCodePoint(codePoint: number): FontMorphOutlineGlyph
  getGlyph(glyphId: number, codePoints?: number[]): FontMorphOutlineGlyph
  getVariation(axes: Record<string, number>): FontMorphOutlineFont
  layout(
    text: string,
    features?: Record<string, boolean>,
    script?: string | string[],
    language?: string,
    direction?: 'ltr' | 'rtl',
  ): FontMorphOutlineGlyphRun
}

export interface ParsedFontMorphFont {
  instance: ReturnType<typeof createFontInstance>
  font: Font
  /** Build-time font engine used for variation-correct outlines and metrics. */
  outlineFont: FontMorphOutlineFont
}

export function parseFontMorphFont(input: FontMorphFontInput): ParsedFontMorphFont {
  const instance = createFontInstance(input)
  if (instance.faceIndex !== 0) {
    throw new RangeError('Glyphflux compiler version 0.1 supports faceIndex 0 only')
  }
  const data = fontArrayBuffer(input.data)
  const baseOutlineFont = createFontkit(new Uint8Array(data)) as unknown as FontMorphOutlineFont
  return {
    instance,
    font: opentype.parse(data),
    outlineFont: Object.keys(instance.axes).length
      ? baseOutlineFont.getVariation(instance.axes)
      : baseOutlineFont,
  }
}
