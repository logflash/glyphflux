export const FONT_MORPH_FIXED_POINT_SCALE = 1_048_576

export function quantizeCoordinate(
  value: number,
  scale = FONT_MORPH_FIXED_POINT_SCALE,
) {
  if (!Number.isFinite(value)) throw new TypeError('Glyphflux coordinates must be finite')
  return Math.round(value * scale) / scale
}

export function compareNumber(left: number, right: number) {
  return left < right ? -1 : left > right ? 1 : 0
}
