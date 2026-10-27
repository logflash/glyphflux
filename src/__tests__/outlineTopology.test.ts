import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { createFontMorphCompiler, type FontMorphPreparedContour } from '../index'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
let compile: Awaited<ReturnType<typeof createFontMorphCompiler>>

beforeAll(async () => {
  const buffer = async (name: string) => {
    const bytes = await readFile(resolve(packageRoot, `demo/public/fonts/${name}`))
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  }
  compile = await createFontMorphCompiler({
    sans: [await buffer('ibm-plex-sans-400-outline.ttf')],
    serif: [await buffer('source-serif-4-600-outline.ttf')],
  })
})

// Rasterize the same positive/negative contour masks as the SVG renderer, then
// count enclosed background regions. This catches temporary splits and holes
// escaping through the outer boundary, not just matching endpoint metadata.
function holeCount(contours: FontMorphPreparedContour[], progress: number) {
  const size = 192
  const polygons = contours.map((contour) => ({
    depth: contour.depth,
    points: contour.source.map(([x, y], index) => [
      x + (contour.target[index][0] - x) * progress,
      y + (contour.target[index][1] - y) * progress,
    ]),
  }))
  const points = polygons.flatMap((polygon) => polygon.points)
  const left = Math.min(...points.map(([x]) => x))
  const top = Math.min(...points.map(([, y]) => y))
  const width = Math.max(...points.map(([x]) => x)) - left
  const height = Math.max(...points.map(([, y]) => y)) - top
  const pixels = new Uint8Array(size * size)
  for (const polygon of polygons) {
    for (let row = 1; row < size - 1; row++) {
      const y = top + ((row - 0.5) / (size - 2)) * height
      const crossings: { x: number; direction: number }[] = []
      for (let i = 0; i < polygon.points.length; i++) {
        const [ax, ay] = polygon.points[i]
        const [bx, by] = polygon.points[(i + 1) % polygon.points.length]
        if (ay > y !== by > y) {
          crossings.push({
            x: ax + ((y - ay) * (bx - ax)) / (by - ay),
            direction: by > ay ? 1 : -1,
          })
        }
      }
      crossings.sort((a, b) => a.x - b.x)
      let winding = 0
      for (let i = 0; i + 1 < crossings.length; i++) {
        winding += crossings[i].direction
        if (winding === 0) continue
        const start = Math.max(1, Math.ceil(((crossings[i].x - left) / width) * (size - 2) + 0.5))
        const end = Math.min(
          size - 1,
          Math.ceil(((crossings[i + 1].x - left) / width) * (size - 2) + 0.5),
        )
        pixels.fill(polygon.depth % 2 === 0 ? 1 : 0, row * size + start, row * size + end)
      }
    }
  }
  const visited = new Uint8Array(pixels.length)
  let holes = 0
  for (let start = 0; start < pixels.length; start++) {
    if (pixels[start] || visited[start]) continue
    let boundary = false
    let area = 0
    const queue = [start]
    visited[start] = 1
    while (queue.length) {
      const index = queue.pop()!
      const x = index % size
      const y = Math.floor(index / size)
      area++
      boundary ||= x === 0 || y === 0 || x === size - 1 || y === size - 1
      for (const neighbor of [index - 1, index + 1, index - size, index + size]) {
        if (neighbor < 0 || neighbor >= pixels.length || visited[neighbor] || pixels[neighbor])
          continue
        if (Math.abs((neighbor % size) - x) + Math.abs(Math.floor(neighbor / size) - y) !== 1)
          continue
        visited[neighbor] = 1
        queue.push(neighbor)
      }
    }
    if (!boundary && area >= 4) holes++
  }
  return holes
}

describe('outline morph counter topology', () => {
  it.each(['404', 'RBO8'])('preserves every counter throughout %s in both directions', (text) => {
    const serif = { role: 'serif' as const, weight: 600, opticalSize: 23 }
    const sans = { role: 'sans' as const, weight: 400, opticalSize: 0 }
    for (const [source, target] of [
      [serif, sans],
      [sans, serif],
    ]) {
      const outline = Object.values(compile([{ text, source, target }]).outlines)[0]
      expect(outline.fallback).toBeUndefined()
      for (let glyphIndex = 0; glyphIndex < text.length; glyphIndex++) {
        const contours = outline.contours!.filter((contour) => contour.glyphIndex === glyphIndex)
        const expected = 'B8'.includes(text[glyphIndex]) ? 2 : 1
        for (let step = 0; step <= 20; step++) {
          expect(
            holeCount(contours, step / 20),
            `${text[glyphIndex]} ${source.role} -> ${target.role} at ${step / 20}`,
          ).toBe(expected)
        }
      }
    }
  })
})
