import type { FontMorphRaster } from './rasterize'

const ORTHOGONAL = 3
const DIAGONAL = 4

function update(
  distances: Uint16Array,
  index: number,
  candidates: readonly [index: number, cost: number][],
) {
  let value = distances[index]
  for (const [candidate, cost] of candidates) {
    value = Math.min(value, distances[candidate] + cost)
  }
  distances[index] = value
}

/** Deterministic chamfer distance to the nearest background pixel. */
export function glyphDistanceField(raster: FontMorphRaster) {
  const { width, height, data } = raster
  const distances = new Uint16Array(data.length)
  for (let index = 0; index < data.length; index += 1) {
    distances[index] = data[index] ? 0xffff : 0
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      if (!data[index]) continue
      const candidates: [number, number][] = []
      if (x > 0) candidates.push([index - 1, ORTHOGONAL])
      if (y > 0) candidates.push([index - width, ORTHOGONAL])
      if (x > 0 && y > 0) candidates.push([index - width - 1, DIAGONAL])
      if (x + 1 < width && y > 0) candidates.push([index - width + 1, DIAGONAL])
      update(distances, index, candidates)
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x
      if (!data[index]) continue
      const candidates: [number, number][] = []
      if (x + 1 < width) candidates.push([index + 1, ORTHOGONAL])
      if (y + 1 < height) candidates.push([index + width, ORTHOGONAL])
      if (x + 1 < width && y + 1 < height) candidates.push([index + width + 1, DIAGONAL])
      if (x > 0 && y + 1 < height) candidates.push([index + width - 1, DIAGONAL])
      update(distances, index, candidates)
    }
  }
  return distances
}
