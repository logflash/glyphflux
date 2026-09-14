export { FontMorphCompilerError, type FontMorphCompilerDiagnosticCode } from './error'
export { createFontInstance, hashFontBytes, type FontMorphFontInput } from './fontIdentity'
export { parseFontMorphFont, type ParsedFontMorphFont } from './fontParser'
export {
  classifyOutlineContours,
  extractFontMorphGlyph,
  extractFontMorphInstantiatedGlyph,
  extractFontMorphInstantiatedGlyphById,
  extractFontMorphInstantiatedRun,
  flattenPath,
  signedPolygonArea,
  type FontMorphExtractedGlyph,
  type FontMorphOutlineContour,
} from './outline'
export { glyphDistanceField } from './distanceField'
export {
  compileSdfGlyphPair,
  compileSdfGlyphPairs,
  compileSdfTextMorph,
  createSdfTextMorphCompiler,
  type FontMorphSdfCompileOptions,
  type FontMorphSdfTextCompiler,
  type FontMorphSdfTextRequest,
} from './sdf'
export { rasterizeFontMorphGlyph, rasterPixelPoint, type FontMorphRaster } from './rasterize'
export {
  resolveFontMorphShapeRequest,
  shapeFontMorphInstantiatedRun,
  shapeFontMorphRun,
  type FontMorphRunShaper,
  type FontMorphShapeRequest,
} from './shaping'
export type {
  FontMorphBounds,
  FontMorphCompiledRun,
  FontMorphFontInstance,
  FontMorphPoint,
  FontMorphShapedGlyph,
} from '../contracts/font'
export type {
  FontMorphSdfEndpoint,
  FontMorphCompiledSdfMorph,
  FontMorphSdfGlyphPair,
  FontMorphSerializedSdfEndpoint,
  FontMorphSerializedSdfGlyphPair,
  FontMorphSdfWarpControl,
  FontMorphSdfWarpRegion,
} from '../contracts/sdf'
export { stableStringify } from '../contracts/stableJson'
