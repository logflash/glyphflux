export type FontMorphPoint = readonly [x: number, y: number]

export interface FontMorphBounds {
  xMin: number
  yMin: number
  xMax: number
  yMax: number
}

export interface FontMorphFontInstance {
  id: string
  sha256: string
  faceIndex: number
  axes: Record<string, number>
}

export interface FontMorphShapedGlyph {
  /** Stable visual-run position used to match this glyph to compiled geometry. */
  key: string
  /** Unicode scalar values retained by the shaping engine after substitution. */
  codePoints: number[]
  /** Text represented by codePoints. Empty for decomposition-only component glyphs. */
  unicode: string
  /** UTF-16 input offset for the shaping cluster, when supplied by the shaper. */
  cluster?: number
  glyphId: number
  x: number
  y: number
  advanceWidth: number
}

export interface FontMorphCompiledRun {
  id: string
  text: string
  fontInstanceId: string
  language: string
  script: string
  direction: 'ltr' | 'rtl'
  features: Record<string, boolean>
  glyphs: FontMorphShapedGlyph[]
  advanceWidth: number
}
