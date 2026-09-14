import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getBrowser } from '../e2e/browser.mjs'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const outputRoot = resolve(packageRoot, 'demo-dist/client')
const catalog = JSON.parse(await readFile(resolve(packageRoot, 'demo/catalog.json'), 'utf8'))
const defaultLocales = catalog.languages.map(({ code }) => code)
const locales = (process.env.GLYPHFLUX_VIEW_LOCALES ?? defaultLocales.join(','))
  .split(',')
  .map((locale) => locale.trim())
  .filter(Boolean)
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
}

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1)
    let file = resolve(outputRoot, relative)
    if (!file.startsWith(outputRoot)) return response.writeHead(404).end('Not found')
    const first = await stat(file).catch(() => null)
    if (first?.isDirectory()) file = resolve(file, 'index.html')
    if (!first && !extname(file)) file = resolve(file, 'index.html')
    if (!(await stat(file).catch(() => null))?.isFile()) {
      return response.writeHead(404).end('Not found')
    }
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    })
    response.end(await readFile(file))
  } catch {
    response.writeHead(404).end('Not found')
  }
})

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
const address = server.address()
assert(address && typeof address !== 'string')

const { browser, close } = await getBrowser()
try {
  for (const viewport of [
    { name: 'desktop', width: 1000, height: 720 },
    { name: 'mobile', width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({ viewport })
    const page = await context.newPage()
    const browserErrors = []
    const generatedRequests = []
    page.on('pageerror', (error) => browserErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text())
    })
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname
      if (pathname.startsWith('/generated/')) generatedRequests.push(pathname)
    })
    for (const locale of locales) {
      const language = catalog.languages.find(({ code }) => code === locale)
      assert(language)
      generatedRequests.length = 0
      await page.goto(`http://127.0.0.1:${address.port}/${locale}/view/sans`, {
        waitUntil: 'networkidle',
      })
      await page.evaluate(() => document.fonts.ready)
      await page.addStyleTag({
        content: ':root { --font-morph-duration: 500ms !important; }',
      })
      for (const destination of ['serif', 'sans']) {
        await page.evaluate(() => {
          const state = {
            samples: [],
            sawActive: false,
            setupFrames: 0,
            blankSetupFrames: 0,
            activeLayers: null,
            done: false,
          }
          globalThis.__glyphfluxHandoffAudit = state
          const opacity = (selector) => {
            const element = document.querySelector(selector)
            return element ? Number.parseFloat(getComputedStyle(element).opacity) : null
          }
          const sample = () => {
            const root = document.querySelector('.font-morph-blend-root')
            if (root) {
              state.sawActive = true
              const sampleValues = {
                source: opacity('.font-morph-source-layer'),
                renderer: opacity('canvas[data-font-morph-renderer="sdf"]'),
                destination: opacity('.font-morph-target-layer'),
              }
              if (Object.values(sampleValues).every((value) => value !== null)) {
                state.samples.push(sampleValues)
                const source = root.querySelector('.font-morph-source-layer')
                const renderer = root.querySelector('canvas[data-font-morph-renderer="sdf"]')
                const target = root.querySelector('.font-morph-target-layer')
                const box = (element) => {
                  const bounds = element.getBoundingClientRect()
                  return {
                    left: bounds.left,
                    top: bounds.top,
                    width: bounds.width,
                    height: bounds.height,
                  }
                }
                state.activeLayers = {
                  isolation: getComputedStyle(root).isolation,
                  sameParent:
                    source?.parentElement === root &&
                    renderer?.parentElement === root &&
                    target?.parentElement === root,
                  blendModes: [source, renderer, target].map((element) =>
                    element ? getComputedStyle(element).mixBlendMode : null,
                  ),
                  sourceText: source?.textContent,
                  targetText: target?.textContent,
                  sourceBox: source ? box(source) : null,
                  targetBox: target ? box(target) : null,
                }
              } else {
                state.setupFrames += 1
                const hasVisibleLayer = [...root.children].some((element) => {
                  const style = getComputedStyle(element)
                  return style.display !== 'none' && Number.parseFloat(style.opacity) > 0.001
                })
                if (!hasVisibleLayer) state.blankSetupFrames += 1
              }
            } else if (state.sawActive) {
              state.done = true
              return
            }
            requestAnimationFrame(sample)
          }
          requestAnimationFrame(sample)
        })
        await page.locator('.view-demo-action button').click()
        await page.waitForURL(`**/${locale}/view/${destination}`)
        await page.waitForFunction(() => globalThis.__glyphfluxHandoffAudit?.done)
        const handoffAudit = await page.evaluate(() => globalThis.__glyphfluxHandoffAudit)
        const activeLayers = handoffAudit?.activeLayers
        assert(
          activeLayers,
          `${viewport.name}:${locale}->${destination} did not produce a complete SDF handoff ${JSON.stringify({ handoffAudit, browserErrors })}`,
        )
        assert.equal(activeLayers.isolation, 'isolate', `${viewport.name}:${locale}: isolation`)
        assert(activeLayers.sameParent, `${viewport.name}:${locale}: shared blend root`)
        assert.deepEqual(activeLayers.blendModes, ['plus-lighter', 'plus-lighter', 'plus-lighter'])
        assert.equal(activeLayers.sourceText, language.text)
        assert.equal(activeLayers.targetText, language.text)
        assert(activeLayers.sourceBox && activeLayers.targetBox)
        for (const property of ['left', 'top', 'width', 'height']) {
          assert(
            Math.abs(activeLayers.sourceBox[property] - activeLayers.targetBox[property]) <= 1,
            `${viewport.name}:${locale}: registered ${property}`,
          )
        }
        await page.waitForFunction(() => !document.querySelector('[data-font-morph-renderer]'))
        const handoffSamples = handoffAudit?.samples ?? []
        assert(handoffAudit?.setupFrames > 0, `${viewport.name}:${locale}: setup observed`)
        assert.equal(
          handoffAudit?.blankSetupFrames,
          0,
          `${viewport.name}:${locale}: no blank preparation frames`,
        )
        assert(handoffSamples.length > 2, `${viewport.name}:${locale}: handoff frames captured`)
        for (const [index, sample] of handoffSamples.entries()) {
          assert(
            sample.source !== null && sample.renderer !== null && sample.destination !== null,
            `${viewport.name}:${locale}: complete handoff sample ${index}`,
          )
          assert(
            Math.abs(sample.source + sample.renderer + sample.destination - 1) <= 0.002,
            `${viewport.name}:${locale}: normalized handoff sample ${index} ${JSON.stringify(sample)}`,
          )
          const visibleLayers = [sample.source, sample.renderer, sample.destination].filter(
            (opacity) => opacity >= 0.999,
          )
          assert.equal(
            visibleLayers.length,
            1,
            `${viewport.name}:${locale}: frame ${index} must use one opaque glyph layer, not cross-fade endpoints ${JSON.stringify(sample)}`,
          )
          assert(
            [sample.source, sample.renderer, sample.destination].every(
              (opacity) => opacity <= 0.001 || opacity >= 0.999,
            ),
            `${viewport.name}:${locale}: frame ${index} must not phase glyph layers ${JSON.stringify(sample)}`,
          )
        }
        const lastHandoff = handoffSamples.at(-1)
        assert(lastHandoff.source <= 0.001, `${viewport.name}:${locale}: source settled`)
        assert(lastHandoff.renderer <= 0.001, `${viewport.name}:${locale}: renderer settled`)
        assert(lastHandoff.destination >= 0.999, `${viewport.name}:${locale}: target settled`)
        assert.equal(await page.locator('.view-heading').textContent(), language.text)
      }
      assert.deepEqual(
        [...new Set(generatedRequests)],
        ['/generated/manifest.json', `/generated/pairs/${language.profile}.json`],
        `${viewport.name}:${locale}: load only the exact font profile`,
      )
      console.log(`${viewport.name}:${locale}: view continuity verified`)
    }
    assert.deepEqual(browserErrors, [])
    await context.close()
  }
} finally {
  await close()
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  )
}

console.log(`Glyphflux live view continuity checks passed for ${locales.length} languages`)
