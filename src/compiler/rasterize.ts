import type { FontMorphBounds, FontMorphPoint } from '../contracts/font'
import type { FontMorphExtractedGlyph } from './outline'

export interface FontMorphRaster {
  width: number
  height: number
  pixelsPerEm: number
  bounds: FontMorphBounds
  data: Uint8Array
}

interface Crossing {
  x: number
  delta: number
}

function alignedBounds(bounds: FontMorphBounds, pixelsPerEm: number) {
  const margin = 2 / pixelsPerEm
  const xMin = Math.floor((bounds.xMin - margin) * pixelsPerEm) / pixelsPerEm
  const yMin = Math.floor((bounds.yMin - margin) * pixelsPerEm) / pixelsPerEm
  const xMax = Math.ceil((bounds.xMax + margin) * pixelsPerEm) / pixelsPerEm
  const yMax = Math.ceil((bounds.yMax + margin) * pixelsPerEm) / pixelsPerEm
  return { xMin, yMin, xMax, yMax }
}

function rowCrossings(contours: readonly { points: readonly FontMorphPoint[] }[], y: number) {
  const crossings: Crossing[] = []
  for (const contour of contours) {
    for (let index = 0; index < contour.points.length; index += 1) {
      const start = contour.points[index]
      const end = contour.points[(index + 1) % contour.points.length]
      if (start[1] === end[1]) continue
      const lower = start[1] < end[1] ? start : end
      const upper = start[1] < end[1] ? end : start
      if (y < lower[1] || y >= upper[1]) continue
      const progress = (y - start[1]) / (end[1] - start[1])
      crossings.push({
        x: start[0] + (end[0] - start[0]) * progress,
        delta: end[1] > start[1] ? 1 : -1,
      })
    }
  }
  crossings.sort((left, right) => left.x - right.x || left.delta - right.delta)
  return crossings
}

export function rasterizeFontMorphGlyph(
  glyph: FontMorphExtractedGlyph,
  pixelsPerEm = 512,
): FontMorphRaster {
  if (!Number.isSafeInteger(pixelsPerEm) || pixelsPerEm < 16 || pixelsPerEm > 4096) {
    throw new RangeError('Glyphflux pixelsPerEm must be an integer from 16 through 4096')
  }
  const bounds = alignedBounds(glyph.bounds, pixelsPerEm)
  const width = Math.max(1, Math.round((bounds.xMax - bounds.xMin) * pixelsPerEm))
  const height = Math.max(1, Math.round((bounds.yMax - bounds.yMin) * pixelsPerEm))
  const data = new Uint8Array(width * height)

  for (let row = 0; row < height; row += 1) {
    const y = bounds.yMax - (row + 0.5) / pixelsPerEm
    const crossings = rowCrossings(glyph.contours, y)
    let crossingIndex = 0
    let winding = 0
    for (let column = 0; column < width; column += 1) {
      const x = bounds.xMin + (column + 0.5) / pixelsPerEm
      while (crossingIndex < crossings.length && crossings[crossingIndex].x <= x) {
        winding += crossings[crossingIndex].delta
        crossingIndex += 1
      }
      if (winding !== 0) data[row * width + column] = 1
    }
  }
  return { width, height, pixelsPerEm, bounds, data }
}

export function rasterPixelPoint(raster: FontMorphRaster, index: number): FontMorphPoint {
  const x = index % raster.width
  const y = Math.floor(index / raster.width)
  return [
    raster.bounds.xMin + (x + 0.5) / raster.pixelsPerEm,
    raster.bounds.yMax - (y + 0.5) / raster.pixelsPerEm,
  ]
}
