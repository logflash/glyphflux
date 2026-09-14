import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { buildGlyphflux } from '../build/build'
import { discoverGlyphfluxText } from '../build/documents'
import { validateGlyphfluxConfig, type LoadedGlyphfluxConfig } from '../build/config'

const temporaryDirectories: string[] = []
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

function baseConfig() {
  return {
    texts: ['Allograph'],
    fonts: { sans: ['sans.ttf'], serif: ['serif.ttf'] },
    morphs: [
      {
        source: { role: 'sans', weights: [500, 400, 500], opticalSizes: [0] },
        target: { role: 'serif', weights: [600], opticalSizes: [23, 20] },
      },
    ],
    output: { manifests: 'public/glyphflux.json' },
  }
}

describe('Glyphflux build configuration', () => {
  it('normalizes deterministic instance sets and defaults', () => {
    const config = validateGlyphfluxConfig(baseConfig())
    expect(config.defaultLocale).toBe('und')
    expect(config.locales).toEqual([])
    expect(config.morphs[0].source.weights).toEqual([400, 500])
    expect(config.morphs[0].target.opticalSizes).toEqual([20, 23])
    expect(config.output.runtimeExport).toBe('glyphfluxLocaleByText')
  })

  it('requires locale placeholders for multilingual artifacts', () => {
    expect(() =>
      validateGlyphfluxConfig({
        ...baseConfig(),
        defaultLocale: 'en',
        locales: ['es'],
        catalogs: { path: 'messages/[locale].json' },
      }),
    ).toThrow(/output\.manifests.*\[locale\]/)
  })

  it('ignores unrelated rich catalog entries while resolving selected string messages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glyphflux-config-'))
    temporaryDirectories.push(root)
    await mkdir(join(root, 'messages'))
    await Promise.all([
      writeFile(
        join(root, 'messages', 'en.json'),
        JSON.stringify({ morph: 'Allograph', rich: [{ t: 'span', c: 'Other content' }] }),
      ),
      writeFile(
        join(root, 'messages', 'es.json'),
        JSON.stringify({ morph: 'Alógrafo', rich: [{ t: 'span', c: 'Otro contenido' }] }),
      ),
    ])
    const configPath = join(root, 'glyphflux.config.json')
    await writeFile(
      configPath,
      JSON.stringify({
        defaultLocale: 'en',
        locales: ['es'],
        catalogs: { path: 'messages/[locale].json' },
        texts: ['Allograph'],
        fonts: {
          sans: [resolve(packageRoot, 'demo/public/fonts/ibm-plex-sans-400-outline.ttf')],
          serif: [resolve(packageRoot, 'demo/public/fonts/source-serif-4-600-outline.ttf')],
        },
        morphs: [
          {
            source: { role: 'sans', weights: [400], opticalSizes: [0] },
            target: { role: 'serif', weights: [600], opticalSizes: [23] },
          },
        ],
        compiler: { size: 64, pixelsPerEm: 256, maximumDistance: 32, supersampling: 2 },
        output: { manifests: 'generated/[locale].json' },
      }),
    )

    const result = await buildGlyphflux({ config: configPath, write: false })
    expect(result.manifests.map(({ locale }) => locale)).toEqual(['en', 'es'])
    expect(result.morphs).toBe(2)
  })

  it('discovers matching static MDX endpoint text across documents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glyphflux-config-'))
    temporaryDirectories.push(root)
    await mkdir(join(root, 'content'))
    await writeFile(
      join(root, 'content', 'source.mdx'),
      '<MorphLink label="Allograph" enabled />\n',
    )
    await writeFile(join(root, 'content', 'target.mdx'), '# Allograph\n')
    const config = validateGlyphfluxConfig({
      ...baseConfig(),
      texts: undefined,
      documents: [
        {
          include: ['content/**/*.mdx'],
          format: 'mdx',
          sources: [
            {
              kind: 'element',
              name: 'MorphLink',
              textAttribute: 'label',
              attributes: { enabled: true },
            },
          ],
          targets: [{ kind: 'heading', depth: 1 }],
        },
      ],
    })
    const discovered = await discoverGlyphfluxText({
      config,
      path: join(root, 'glyphflux.config.json'),
      root,
    } satisfies LoadedGlyphfluxConfig)

    expect(discovered.sources).toEqual(['Allograph'])
    expect(discovered.targets).toEqual(['Allograph'])
    expect(discovered.files).toEqual(['content/source.mdx', 'content/target.mdx'])
  })

  it('rejects source text without a same-text destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glyphflux-config-'))
    temporaryDirectories.push(root)
    await writeFile(join(root, 'source.mdx'), '<MorphLink label="Allograph" />\n# Different\n')
    const config = validateGlyphfluxConfig({
      ...baseConfig(),
      texts: undefined,
      documents: [
        {
          include: ['*.mdx'],
          format: 'mdx',
          sources: [{ kind: 'element', name: 'MorphLink', textAttribute: 'label' }],
          targets: [{ kind: 'heading', depth: 1 }],
        },
      ],
    })

    await expect(
      discoverGlyphfluxText({ config, path: join(root, 'glyphflux.config.json'), root }),
    ).rejects.toThrow(/has no same-text target/)
  })
})
