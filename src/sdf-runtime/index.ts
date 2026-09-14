import type { FontMorphSdfGlyphPair } from '../contracts/sdf'

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value))
}

function interpolate(source: number, target: number, progress: number) {
  // Barycentric form is deliberately symmetric under
  // (source, target, t) -> (target, source, 1 - t).
  return source * (1 - progress) + target * progress
}

function smoothstep(value: number) {
  const clamped = clamp(value, 0, 1)
  return clamped * clamped * (3 - 2 * clamped)
}

function sample(field: Uint8Array, size: number, x: number, y: number) {
  const clampedX = clamp(x, 0, size - 1)
  const clampedY = clamp(y, 0, size - 1)
  const x0 = Math.floor(clampedX)
  const y0 = Math.floor(clampedY)
  const x1 = Math.min(size - 1, x0 + 1)
  const y1 = Math.min(size - 1, y0 + 1)
  const fractionX = clampedX - x0
  const fractionY = clampedY - y0
  const top = interpolate(field[y0 * size + x0], field[y0 * size + x1], fractionX)
  const bottom = interpolate(field[y1 * size + x0], field[y1 * size + x1], fractionX)
  return interpolate(top, bottom, fractionY)
}

interface PreparedRegion {
  centerX: number
  centerY: number
  inverseRadiusX: number
  inverseRadiusY: number
  shiftX: number
  shiftY: number
  distanceBias: number
}

// Fallback for callers that render a field without supplying its display size.
// Browser rendering derives a scale-aware ramp below so the antialiasing band
// remains approximately one physical pixel instead of exposing SDF texels.
const MINIMUM_SDF_COVERAGE_RAMP = 4
const CHAMFER_ORTHOGONAL_DISTANCE = 3
const ENCODED_DISTANCE_RANGE = 127
const TEMPORAL_PROGRESS_STEPS = 0x1_0000

export interface FontMorphSdfAlphaOptions {
  /** Width of the spatial antialiasing band in encoded signed-distance units. */
  coverageRamp?: number
}

/**
 * Resolves a spatial coverage ramp for a glyph's current display scale.
 *
 * Signed distances are stored in texture space while the glyph is composited
 * in device pixels. Keeping the coverage band near one physical pixel prevents
 * a small field from looking blocky when enlarged, without adding a temporal
 * source/target cross-fade.
 */
export function fontMorphSdfCoverageRamp(
  pair: Pick<FontMorphSdfGlyphPair, 'size' | 'maximumDistance'>,
  renderedWidth: number,
  renderedHeight: number,
  devicePixelRatio = 1,
) {
  const renderedExtent = Math.max(Math.abs(renderedWidth), Math.abs(renderedHeight))
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  if (
    !Number.isFinite(renderedExtent) ||
    renderedExtent <= 0 ||
    !Number.isFinite(pair.maximumDistance) ||
    pair.maximumDistance <= 0
  ) {
    return MINIMUM_SDF_COVERAGE_RAMP
  }
  const encodedDistancePerTexel =
    (CHAMFER_ORTHOGONAL_DISTANCE * ENCODED_DISTANCE_RANGE) / pair.maximumDistance
  const textureTexelsPerDevicePixel = pair.size / (renderedExtent * ratio)
  return Math.max(
    MINIMUM_SDF_COVERAGE_RAMP,
    Math.min(ENCODED_DISTANCE_RANGE, encodedDistancePerTexel * textureTexelsPerDevicePixel),
  )
}

function prepareRegions(pair: FontMorphSdfGlyphPair, progress: number): PreparedRegion[] {
  const extent = pair.size - 1
  return pair.warpRegions.map((region) => ({
    centerX: interpolate(region.source.center[0], region.target.center[0], progress) * extent,
    centerY: interpolate(region.source.center[1], region.target.center[1], progress) * extent,
    inverseRadiusX:
      1 /
      Math.max(
        Number.EPSILON,
        interpolate(region.source.radius[0], region.target.radius[0], progress) * extent,
      ),
    inverseRadiusY:
      1 /
      Math.max(
        Number.EPSILON,
        interpolate(region.source.radius[1], region.target.radius[1], progress) * extent,
      ),
    shiftX: (region.target.center[0] - region.source.center[0]) * extent,
    shiftY: (region.target.center[1] - region.source.center[1]) * extent,
    distanceBias: region.distanceBias ?? 0,
  }))
}

function validateBuffers(
  pair: FontMorphSdfGlyphPair,
  output: Float32Array<ArrayBufferLike> | Uint8ClampedArray<ArrayBufferLike>,
) {
  const expectedLength = pair.size * pair.size
  if (
    pair.source.distance.length !== expectedLength ||
    pair.target.distance.length !== expectedLength ||
    output.length !== expectedLength
  ) {
    throw new RangeError('Glyphflux distance-field buffers do not match the declared square size')
  }
}

function alphaFromDistance(distance: number, ramp = MINIMUM_SDF_COVERAGE_RAMP) {
  const coverage = Math.round(clamp(0.5 + (distance - 128) / ramp, 0, 1) * 255)
  // Widening the antialiasing band must not move its structural boundary.
  // Reserve the upper half of coverage for positive signed distance and the
  // lower half for negative/zero distance; the one-level correction is below
  // visible precision but prevents a thin stroke from splitting transiently.
  return distance > 128 ? Math.max(129, coverage) : Math.min(128, coverage)
}

function shapeProgress(progress: number) {
  // Ease the field itself, rather than widening its coverage ramp. Widening
  // makes source-only and target-only strokes translucent and becomes a hidden
  // cross-dissolve. This symmetric construction keeps a crisp spatial edge,
  // reaches each endpoint with zero velocity, and remains identical in reverse.
  return progress <= 0.5 ? smoothstep(progress) : 1 - smoothstep(1 - progress)
}

function renderFrame(
  pair: FontMorphSdfGlyphPair,
  progress: number,
  output: Float32Array<ArrayBufferLike> | Uint8ClampedArray<ArrayBufferLike>,
  alpha: boolean,
  coverageRamp = MINIMUM_SDF_COVERAGE_RAMP,
) {
  // Quantize to an even fixed-point denominator so t and 1 - t are exact
  // complements. This removes float-rounding hysteresis when replay reverses.
  const clampedProgress =
    Math.round(clamp(progress, 0, 1) * TEMPORAL_PROGRESS_STEPS) / TEMPORAL_PROGRESS_STEPS
  const outlineProgress = shapeProgress(clampedProgress)
  validateBuffers(pair, output)
  const source = pair.source.distance
  const target = pair.target.distance
  if (!alpha && clampedProgress === 0) {
    output.set(source)
    return output
  }
  if (!alpha && clampedProgress === 1) {
    output.set(target)
    return output
  }

  if (pair.warpRegions.length === 0 || clampedProgress === 0 || clampedProgress === 1) {
    for (let index = 0; index < output.length; index += 1) {
      const distance = interpolate(source[index], target[index], outlineProgress)
      output[index] = alpha ? alphaFromDistance(distance, coverageRamp) : distance
    }
    return output
  }

  const regions = prepareRegions(pair, outlineProgress)
  const biasProgress = 4 * outlineProgress * (1 - outlineProgress)
  let index = 0
  for (let y = 0; y < pair.size; y += 1) {
    for (let x = 0; x < pair.size; x += 1, index += 1) {
      let offsetX = 0
      let offsetY = 0
      let totalWeight = 0
      let distanceBias = 0
      for (const region of regions) {
        const normalizedX = Math.abs(x - region.centerX) * region.inverseRadiusX
        if (normalizedX >= 1) continue
        const normalizedY = Math.abs(y - region.centerY) * region.inverseRadiusY
        if (normalizedY >= 1) continue
        const weight = (1 - smoothstep(normalizedX)) * (1 - smoothstep(normalizedY))
        offsetX += region.shiftX * weight
        offsetY += region.shiftY * weight
        totalWeight += weight
        distanceBias += region.distanceBias * weight
      }
      if (totalWeight > 1) {
        offsetX /= totalWeight
        offsetY /= totalWeight
        distanceBias /= totalWeight
      }
      let sourceDistance: number
      let targetDistance: number
      if (totalWeight === 0) {
        sourceDistance = source[index]
        targetDistance = target[index]
      } else {
        sourceDistance = sample(
          source,
          pair.size,
          x - outlineProgress * offsetX,
          y - outlineProgress * offsetY,
        )
        targetDistance = sample(
          target,
          pair.size,
          x + (1 - outlineProgress) * offsetX,
          y + (1 - outlineProgress) * offsetY,
        )
      }
      const distance =
        interpolate(sourceDistance, targetDistance, outlineProgress) + distanceBias * biasProgress
      output[index] = alpha ? alphaFromDistance(distance, coverageRamp) : distance
    }
  }
  return output
}

/**
 * Evaluates one precompiled distance-field glyph at an absolute progress value.
 * Structural matching is absent from this runtime; automatic local registration
 * has already been resolved deterministically during compilation.
 */
export function renderFontMorphSdfFrame(
  pair: FontMorphSdfGlyphPair,
  progress: number,
  output: Float32Array<ArrayBufferLike> = new Float32Array(pair.size * pair.size),
) {
  return renderFrame(pair, progress, output, false) as Float32Array<ArrayBufferLike>
}

/**
 * Evaluates the precompiled correspondence directly into an 8-bit coverage
 * buffer. Partial alpha exists only at the moving spatial boundary; source-only
 * and target-only strokes remain opaque instead of cross-dissolving over time.
 */
export function renderFontMorphSdfAlphaFrame(
  pair: FontMorphSdfGlyphPair,
  progress: number,
  output: Uint8ClampedArray<ArrayBufferLike> = new Uint8ClampedArray(pair.size * pair.size),
  options: FontMorphSdfAlphaOptions = {},
) {
  const coverageRamp =
    Number.isFinite(options.coverageRamp) && (options.coverageRamp ?? 0) > 0
      ? options.coverageRamp
      : MINIMUM_SDF_COVERAGE_RAMP
  return renderFrame(
    pair,
    progress,
    output,
    true,
    coverageRamp,
  ) as Uint8ClampedArray<ArrayBufferLike>
}

export type {
  FontMorphSdfGlyphPair,
  FontMorphSdfWarpControl,
  FontMorphSdfWarpRegion,
} from '../contracts/sdf'
