import type { FontMorphBounds, FontMorphPoint } from './font'

/** A compiler-derived local registration control in normalized texture space. */
export interface FontMorphSdfWarpControl {
  center: FontMorphPoint
  radius: FontMorphPoint
}

export interface FontMorphSdfWarpRegion {
  /** Stable compiler-assigned identity used only for diagnostics. */
  id: string
  source: FontMorphSdfWarpControl
  target: FontMorphSdfWarpControl
  /** Signed-distance correction at the transition midpoint; zero at both endpoints. */
  distanceBias?: number
}

export interface FontMorphSdfEndpoint {
  fontInstanceId: string
  glyphId: number
  advanceWidth: number
  /** Bounds represented by the square distance grid, in em-relative units. */
  textureBounds: FontMorphBounds
  /** Signed distance encoded around 128; values above 128 are inside the glyph. */
  distance: Uint8Array
}

export interface FontMorphSdfGlyphPair {
  /** Stable key shared by the source and target shaped runs. */
  key?: string
  unicode: string
  size: number
  maximumDistance: number
  /** Build-resolved structural correspondence; runtime performs no matching. */
  warpRegions: FontMorphSdfWarpRegion[]
  source: FontMorphSdfEndpoint
  target: FontMorphSdfEndpoint
}

export interface FontMorphCompiledSdfMorph {
  sourceRun: import('./font').FontMorphCompiledRun
  targetRun: import('./font').FontMorphCompiledRun
  glyphs: Record<string, FontMorphSdfGlyphPair>
}

export interface FontMorphSerializedSdfEndpoint extends Omit<FontMorphSdfEndpoint, 'distance'> {
  distanceBase64: string
}

export interface FontMorphSerializedSdfGlyphPair extends Omit<
  FontMorphSdfGlyphPair,
  'source' | 'target'
> {
  source: FontMorphSerializedSdfEndpoint
  target: FontMorphSerializedSdfEndpoint
}
