import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface FontFixture {
  id: string
  file: string
  sha256: string
  faceIndex: number
  axes: Record<string, number>
}

interface FontFixtureManifest {
  version: 1
  fonts: FontFixture[]
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

describe('font compiler fixtures', () => {
  it('uses the reviewed font bytes and instance coordinates', async () => {
    const manifest = JSON.parse(
      await readFile(resolve(packageRoot, 'test/fixtures/font-instances.json'), 'utf8'),
    ) as FontFixtureManifest

    expect(manifest.version).toBe(1)
    expect(manifest.fonts.map(({ id }) => id)).toEqual([
      'ibm-plex-sans-400',
      'source-serif-4-600',
      'noto-sans-jp-400',
      'noto-serif-jp-600',
    ])

    for (const fixture of manifest.fonts) {
      const bytes = await readFile(resolve(packageRoot, fixture.file))
      expect(createHash('sha256').update(bytes).digest('hex'), fixture.id).toBe(fixture.sha256)
      expect(fixture.faceIndex, fixture.id).toBe(0)
      expect(Object.keys(fixture.axes), fixture.id).toEqual(Object.keys(fixture.axes).sort())
    }
  })
})
