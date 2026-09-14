import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileSdfGlyphPair } from '../dist/compiler/index.mjs'
import { renderFontMorphSdfFrame } from '../dist/sdf-runtime/index.mjs'
import { getBrowser } from '../e2e/browser.mjs'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const outputRoot = resolve(packageRoot, 'test-results/sdf')
const fixtures = [
  ['R', 'ibm-plex-sans-400-outline.ttf', 'source-serif-4-600-outline.ttf'],
  ['履', 'noto-sans-jp-400-outline.ttf', 'noto-serif-jp-600-outline.ttf'],
  ['歴', 'noto-sans-jp-400-outline.ttf', 'noto-serif-jp-600-outline.ttf'],
  ['書', 'noto-sans-jp-400-outline.ttf', 'noto-serif-jp-600-outline.ttf'],
]
const progressValues = [0, 0.01, 0.125, 0.25, 0.5, 0.75, 0.875, 0.99, 1]
const size = 192

const font = async (file) => {
  const bytes = await readFile(resolve(packageRoot, 'demo/public/fonts', file))
  return { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
}

function componentCount(field) {
  const visited = new Uint8Array(field.length)
  let components = 0
  for (let start = 0; start < field.length; start += 1) {
    if (field[start] <= 128 || visited[start]) continue
    components += 1
    const queue = [start]
    visited[start] = 1
    while (queue.length) {
      const index = queue.pop()
      const x = index % size
      const y = Math.floor(index / size)
      for (const neighbor of [index - 1, index + 1, index - size, index + size]) {
        const nx = neighbor % size
        const ny = Math.floor(neighbor / size)
        if (neighbor < 0 || neighbor >= field.length || Math.abs(nx - x) + Math.abs(ny - y) !== 1)
          continue
        if (field[neighbor] > 128 && !visited[neighbor]) {
          visited[neighbor] = 1
          queue.push(neighbor)
        }
      }
    }
  }
  return components
}

await mkdir(outputRoot, { recursive: true })
const { browser, close } = await getBrowser()
try {
  const page = await browser.newPage({
    viewport: { width: progressValues.length * 200, height: 230 },
  })
  for (const [unicode, sourceFile, targetFile] of fixtures) {
    const pair = compileSdfGlyphPair(await font(sourceFile), await font(targetFile), unicode, {
      size,
      pixelsPerEm: 768,
      maximumDistance: 48,
      supersampling: 4,
    })
    const baselinePair = { ...pair, warpRegions: [] }
    const baselineFrames = progressValues.map((progress) =>
      renderFontMorphSdfFrame(baselinePair, progress),
    )
    const frames = progressValues.map((progress) => renderFontMorphSdfFrame(pair, progress))
    const endpointMaximum = Math.max(componentCount(frames[0]), componentCount(frames.at(-1)))
    const baselineCounts = baselineFrames.map(componentCount)
    const resultCounts = frames.map(componentCount)
    const hasTopologySpike = baselineCounts.slice(1, -1).some((count) => count > endpointMaximum)
    if (hasTopologySpike && !pair.warpRegions.length) {
      throw new Error(`${unicode} has a transient topology spike without automatic registration`)
    }
    if (resultCounts.slice(1, -1).some((count) => count > endpointMaximum)) {
      throw new Error(`${unicode} retains a transient topology spike after structural warping`)
    }
    console.log(
      `${unicode}: baseline=${baselineCounts.join(',')}; regions=${pair.warpRegions.length}; result=${resultCounts.join(',')}`,
    )

    await page.setContent(
      `<style>body{margin:0;background:white;font:12px monospace}.row{display:flex}.cell{width:200px}.label{height:25px}.cell canvas{width:192px;height:192px;image-rendering:auto}</style><div class="row">${progressValues.map((progress, index) => `<div class="cell"><div class="label">t=${progress}</div><canvas data-index="${index}" width="${size}" height="${size}"></canvas></div>`).join('')}</div>`,
    )
    await page.evaluate(
      ({ frames, size }) => {
        for (const canvas of document.querySelectorAll('canvas')) {
          const distances = frames[Number(canvas.dataset.index)]
          const context = canvas.getContext('2d')
          const image = context.createImageData(size, size)
          for (let index = 0; index < distances.length; index += 1) {
            const coverage = Math.max(0, Math.min(1, 0.5 + (distances[index] - 128) / 12))
            image.data[index * 4] = 23
            image.data[index * 4 + 1] = 23
            image.data[index * 4 + 2] = 23
            image.data[index * 4 + 3] = Math.round(coverage * 255)
          }
          context.putImageData(image, 0, 0)
        }
      },
      { frames: frames.map((frame) => [...frame]), size },
    )
    const id = unicode.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
    await page.screenshot({ path: resolve(outputRoot, `sdf-U+${id}.png`) })
  }
  await page.close()
} finally {
  await close()
}
console.log(`wrote signed-distance diagnostics to ${outputRoot}`)
