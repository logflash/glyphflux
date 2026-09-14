import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  configureFontMorph,
  compileFontMorphManifest,
  createFontMorphFrameRenderer,
  prepareFontMorph,
} from '../index'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

describe('Glyphflux public API', () => {
  it('can be configured without browser globals', () => {
    expect(() =>
      configureFontMorph({
        fontFiles: { sans: ['/sans.otf'], serif: ['/serif.otf'] },
      }),
    ).not.toThrow()
  })

  it('makes server-side preparation a no-op', async () => {
    await expect(prepareFontMorph('title')).resolves.toBeUndefined()
  })

  it('accepts an explicit teardown frame without browser globals', () => {
    const render = createFontMorphFrameRenderer()
    expect(
      render({
        document: null,
        payload: null,
        text: '',
        progress: 0,
        phase: 'idle',
      }),
    ).toBeUndefined()
  })

  it('uses variation-correct disconnected contours in prepared KUTE outlines', async () => {
    const [sansBytes, serifBytes] = await Promise.all([
      readFile(resolve(packageRoot, 'demo/public/fonts/ibm-plex-sans-400-outline.ttf')),
      readFile(resolve(packageRoot, 'demo/public/fonts/source-serif-4-600-outline.ttf')),
    ])
    const manifest = await compileFontMorphManifest(
      {
        sans: [sansBytes.buffer.slice(sansBytes.byteOffset, sansBytes.byteOffset + sansBytes.byteLength)],
        serif: [serifBytes.buffer.slice(serifBytes.byteOffset, serifBytes.byteOffset + serifBytes.byteLength)],
      },
      [{
        text: 'í',
        source: { role: 'sans', weight: 500, opticalSize: 0 },
        target: { role: 'serif', weight: 600, opticalSize: 60 },
      }],
    )
    const outline = Object.values(manifest.outlines)[0]
    const accent = outline.contours
      ?.filter((contour) => contour.glyphIndex === 0 && contour.depth === 0)
      .map((contour) => ({
        contour,
        top: Math.min(...contour.target.map(([, y]) => y)),
      }))
      .sort((left, right) => left.top - right.top)[0]?.contour
    expect(accent).toBeDefined()
    const horizontal = accent!.target.map(([x]) => x)
    expect(Math.min(...horizontal)).toBeCloseTo(99, 0)
    expect(Math.max(...horizontal)).toBeCloseTo(281, 0)
  })

  it('leaves static fallback faces uninstanced in prepared KUTE outlines', async () => {
    const [sansBytes, serifBytes] = await Promise.all([
      readFile(resolve(packageRoot, 'demo/public/fonts/noto-sans-jp-400-outline.ttf')),
      readFile(resolve(packageRoot, 'demo/public/fonts/noto-serif-jp-600-outline.ttf')),
    ])
    const manifest = await compileFontMorphManifest(
      {
        sans: [sansBytes.buffer.slice(sansBytes.byteOffset, sansBytes.byteOffset + sansBytes.byteLength)],
        serif: [serifBytes.buffer.slice(serifBytes.byteOffset, serifBytes.byteOffset + serifBytes.byteLength)],
      },
      [{
        text: '履歴書',
        source: { role: 'sans', weight: 500, opticalSize: 0 },
        target: { role: 'serif', weight: 600, opticalSize: 23 },
      }],
    )
    const outline = Object.values(manifest.outlines)[0]
    expect(outline.fallback).toBeUndefined()
    expect(outline.contours?.length).toBeGreaterThan(0)
  })
})
