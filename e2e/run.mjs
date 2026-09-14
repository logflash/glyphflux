import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import opentype from 'opentype.js'
import { compileFontMorphManifest, fontMorphPreparedKey } from '../dist/index.mjs'
import {
  compileSdfGlyphPairs,
  parseFontMorphFont,
  shapeFontMorphInstantiatedRun,
} from '../dist/compiler/index.mjs'
import { getBrowser, newPage } from './browser.mjs'

function glyphPath({ serif }) {
  const path = new opentype.Path()
  if (serif) {
    path.moveTo(30, 0)
    path.lineTo(570, 0)
    path.lineTo(540, 75)
    path.lineTo(525, 625)
    path.lineTo(570, 700)
    path.lineTo(30, 700)
    path.lineTo(75, 625)
    path.lineTo(60, 75)
    path.close()
    path.moveTo(170, 205)
    path.lineTo(170, 515)
    path.lineTo(430, 515)
    path.lineTo(430, 205)
    path.close()
  } else {
    path.moveTo(50, 0)
    path.lineTo(550, 0)
    path.lineTo(550, 700)
    path.lineTo(50, 700)
    path.close()
    path.moveTo(180, 225)
    path.lineTo(180, 495)
    path.lineTo(420, 495)
    path.lineTo(420, 225)
    path.close()
  }
  return path
}

function fixtureFont(familyName, serif) {
  const notdef = new opentype.Glyph({
    name: '.notdef',
    unicode: 0,
    advanceWidth: 650,
    path: glyphPath({ serif: false }),
  })
  const e = new opentype.Glyph({
    name: 'e',
    unicode: 101,
    advanceWidth: serif ? 690 : 640,
    path: glyphPath({ serif }),
  })
  const font = new opentype.Font({
    familyName,
    styleName: 'Regular',
    unitsPerEm: 1_000,
    ascender: 800,
    descender: -200,
    glyphs: [notdef, e],
  })
  return Buffer.from(font.toArrayBuffer())
}

function primaryMetricsFont() {
  const notdef = new opentype.Glyph({
    name: '.notdef',
    unicode: 0,
    advanceWidth: 650,
    path: glyphPath({ serif: false }),
  })
  const x = new opentype.Glyph({
    name: 'x',
    unicode: 120,
    advanceWidth: 650,
    path: glyphPath({ serif: false }),
  })
  return Buffer.from(
    new opentype.Font({
      familyName: 'Fixture Primary',
      styleName: 'Regular',
      unitsPerEm: 1_000,
      ascender: 900,
      descender: -300,
      glyphs: [notdef, x],
    }).toArrayBuffer(),
  )
}

const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/styles.css">
    <style>
      @font-face { font-family: "Fixture Sans"; src: url("/sans.otf"); }
      @font-face { font-family: "Fixture Serif"; src: url("/serif.otf"); }
      @font-face { font-family: "Fixture Primary"; src: url("/primary.otf"); }
      :root {
        /* Keep the live test open long enough for resize sampling on slow CI. */
        --font-morph-duration: 4000ms;
        /* Ensure endpoint-scoped build identities win over root defaults. */
        --font-morph-sans-weight: 500;
        --font-morph-serif-weight: 600;
        --font-morph-serif-optical-size: 23;
      }
      #fixture {
        --font-morph-sans-weight: 400;
        --font-morph-serif-weight: 400;
        --font-morph-serif-optical-size: 104;
      }
      body { margin: 0; min-height: 100vh; background: #fff; }
      #fixture { position: relative; height: 600px; }
      .endpoint { position: absolute; display: inline-block; white-space: pre; line-height: 1; }
      .sans { left: 32px; top: 48px; color: rgb(72 35 128); font: 400 52px/normal "Fixture Primary", "Fixture Sans"; }
      .serif { left: 310px; top: 230px; color: rgb(15 70 105); font: 400 104px/normal "Fixture Primary", "Fixture Serif"; }
      :root.simulated-mobile-text-scaling .sans { transform: scale(.83); transform-origin: top left; }
      :root.simulated-mobile-text-scaling .serif { font-size: 109px; }
      .serif.moved { left: 55vw; top: 28vh; font-size: 84px; }
      #replay-overlay { position: fixed; inset: 0; pointer-events: none; }
    </style>
  </head>
  <body>
    <main id="fixture"><span class="endpoint sans" data-font-morph="sample">ee</span></main>
    <div id="replay-overlay"></div>
    <script type="module" src="/bundle.js"></script>
  </body>
</html>`

const fixtureBuild = await build({
  entryPoints: [fileURLToPath(new URL('./fixture.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  write: false,
})
const [{ text: bundle }] = fixtureBuild.outputFiles
const workerBundle = await readFile(new URL('../dist/outline-worker.js', import.meta.url))

const sansFont = fixtureFont('Fixture Sans', false)
const serifFont = fixtureFont('Fixture Serif', true)
const primaryFont = primaryMetricsFont()
const sourceInstance = { role: 'sans', weight: 400, opticalSize: 0 }
const targetInstance = { role: 'serif', weight: 400, opticalSize: 104 }
const sourceInput = {
  data: sansFont.buffer.slice(sansFont.byteOffset, sansFont.byteOffset + sansFont.byteLength),
}
const targetInput = {
  data: serifFont.buffer.slice(serifFont.byteOffset, serifFont.byteOffset + serifFont.byteLength),
}
const outlineManifest = await compileFontMorphManifest(
  {
    sans: [sourceInput.data],
    serif: [targetInput.data],
  },
  [
    {
      text: 'ee',
      source: sourceInstance,
      target: targetInstance,
    },
  ],
)
const sourceParsed = parseFontMorphFont(sourceInput)
const targetParsed = parseFontMorphFont(targetInput)
const [sdfGlyph] = compileSdfGlyphPairs(sourceInput, targetInput, ['e'], {
  size: 64,
  pixelsPerEm: 512,
  maximumDistance: 64,
  supersampling: 4,
})
const serializeEndpoint = ({ distance, ...endpoint }) => ({
  ...endpoint,
  distanceBase64: Buffer.from(distance).toString('base64'),
})
const preparedManifest = {
  version: 2,
  outlines: outlineManifest.outlines,
  sdfMorphs: {
    [fontMorphPreparedKey('ee', sourceInstance, targetInstance)]: {
      sourceRun: shapeFontMorphInstantiatedRun(sourceParsed.outlineFont, {
        text: 'ee',
        fontInstanceId: sourceParsed.instance.id,
        language: 'en',
      }),
      targetRun: shapeFontMorphInstantiatedRun(targetParsed.outlineFont, {
        text: 'ee',
        fontInstanceId: targetParsed.instance.id,
        language: 'en',
      }),
      glyphs: {
        e: {
          ...sdfGlyph,
          source: serializeEndpoint(sdfGlyph.source),
          target: serializeEndpoint(sdfGlyph.target),
        },
      },
    },
  },
}

const assets = new Map([
  ['/', ['text/html; charset=utf-8', Buffer.from(html)]],
  ['/bundle.js', ['text/javascript; charset=utf-8', Buffer.from(bundle)]],
  ['/outline-worker.js', ['text/javascript; charset=utf-8', workerBundle]],
  [
    '/prepared.json',
    ['application/json; charset=utf-8', Buffer.from(JSON.stringify(preparedManifest))],
  ],
  ['/favicon.ico', ['image/x-icon', Buffer.alloc(0)]],
  [
    '/styles.css',
    ['text/css; charset=utf-8', Buffer.from(await readFile(new URL('../styles.css', import.meta.url)))],
  ],
  ['/sans.otf', ['font/otf', sansFont]],
  ['/serif.otf', ['font/otf', serifFont]],
  ['/primary.otf', ['font/otf', primaryFont]],
  ['/sans-outline.otf', ['font/otf', sansFont]],
  ['/serif-outline.otf', ['font/otf', serifFont]],
])

const requests = new Map()

const server = createServer((request, response) => {
  requests.set(request.url, (requests.get(request.url) ?? 0) + 1)
  const asset = assets.get(request.url ?? '/')
  if (!asset) {
    response.writeHead(404).end('Not found')
    return
  }
  response.writeHead(200, { 'Content-Type': asset[0], 'Cache-Control': 'no-store' })
  response.end(asset[1])
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
assert(address && typeof address !== 'string')

const errors = []
let closeBrowser
try {
  const { browser, close } = await getBrowser()
  closeBrowser = close
  const page = await newPage(browser)
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.setViewportSize({ width: 900, height: 700 })
  await page.goto(`http://127.0.0.1:${address.port}`, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)

  const preparation = await page.evaluate(async () => {
    const started = performance.now()
    await window.fontMorphFixture.prepare()
    return performance.now() - started
  })
  assert(preparation >= 0, 'preparation should complete')
  assert.equal(requests.get('/sans-outline.otf') ?? 0, 0, 'prepared text should not fetch outlines')
  assert.equal(requests.get('/serif-outline.otf') ?? 0, 0, 'prepared text should not fetch outlines')
  await page.evaluate(() => window.fontMorphFixture.simulateBrowserTextScaling())
  const sourceBaselineRatio = await page.evaluate(() => {
    const source = document.querySelector('[data-font-morph="sample"]')
    const marker = document.createElement('i')
    marker.style.cssText =
      'display:inline-block;width:0;height:0;margin:0;padding:0;border:0;vertical-align:baseline;'
    source.append(marker)
    const sourceRect = source.getBoundingClientRect()
    const baseline = (marker.getBoundingClientRect().top - sourceRect.top) / sourceRect.height
    marker.remove()
    return baseline
  })
  assert.equal(await page.evaluate(() => window.fontMorphFixture.begin()), true)
  await page.waitForSelector('.font-morph-layer[data-font-morph-renderer="dom"]')
  const initialText = await page.evaluate(() => {
    const source = document.querySelector('[data-font-morph="sample"]')
    const layer = document.querySelector('[data-font-morph-renderer="dom"]')
    const textRect = (element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      return range.getBoundingClientRect().toJSON()
    }
    const sourceStyle = getComputedStyle(source)
    const layerStyle = getComputedStyle(layer)
    const layerText = layer.querySelector('font-morph-text')
    return {
      sourceRect: textRect(source),
      layerRect: textRect(layerText),
      sourceFont: sourceStyle.font,
      layerFont: layerStyle.font,
      sourceSpacing: sourceStyle.letterSpacing,
      layerSpacing: layerStyle.letterSpacing,
    }
  })
  assert.equal(initialText.layerFont, initialText.sourceFont)
  assert.equal(initialText.layerSpacing, initialText.sourceSpacing)
  assert(
    ['left', 'top', 'width', 'height'].every(
      (property) =>
        Math.abs(initialText.layerRect[property] - initialText.sourceRect[property]) < 0.1,
    ),
    `the pre-navigation source must retain its exact text box: ${JSON.stringify(initialText)}`,
  )
  await page.evaluate(() => window.fontMorphFixture.show('serif'))

  await page.waitForSelector('.font-morph-layer[data-font-morph-renderer="sdf"]', {
    state: 'attached',
  })
  const handoffSnapshot = await page.evaluate(() => ({
    active: document.documentElement.dataset.fontMorphActive,
    layers: [...document.querySelectorAll('[data-font-morph-renderer]')].map((layer) => ({
      className: layer.className,
      renderer: layer.getAttribute('data-font-morph-renderer'),
    })),
  }))
  assert.equal(
    handoffSnapshot.layers.filter(
      (layer) =>
        String(layer.className).includes('font-morph-source-layer') &&
        layer.renderer === 'dom',
    ).length,
    1,
    `the exact browser-rendered source should remain mounted for the opening handoff: ${JSON.stringify(handoffSnapshot)}`,
  )
  const liveHandoffStates = await page.evaluate(() => {
    const source = document.querySelector('.font-morph-source-layer')
    const renderer = document.querySelector('.font-morph-layer[data-font-morph-renderer="sdf"]')
    const destination = document.querySelector('.font-morph-target-layer')
    const root = document.querySelector('.font-morph-blend-root')
    const opacity = (element) =>
      element instanceof HTMLElement ? Number(getComputedStyle(element).opacity) : null
    return {
      isolation: root ? getComputedStyle(root).isolation : null,
      sameParent:
        Boolean(root) &&
        source?.parentElement === root &&
        renderer?.parentElement === root &&
        destination?.parentElement === root,
      opacities: [opacity(source), opacity(renderer), opacity(destination)],
    }
  })
  assert.equal(liveHandoffStates.isolation, 'isolate')
  assert(liveHandoffStates.sameParent, 'all live handoff layers must share the isolated blend root')
  const handoffOpacities = liveHandoffStates.opacities.filter((value) => value !== null)
  assert(
    handoffOpacities.length === 3 &&
      handoffOpacities.every((value) => value === 0 || value === 1) &&
      handoffOpacities.reduce((sum, value) => sum + value, 0) === 1,
    `live endpoint handoffs must show exactly one layer: ${JSON.stringify(liveHandoffStates)}`,
  )
  const samples = []
  for (let index = 0; index < 8; index += 1) {
    if (index === 3) {
      await page.setViewportSize({ width: 760, height: 620 })
      await page.evaluate(() => window.fontMorphFixture.moveDestination())
    }
    samples.push(
      await page.evaluate(() => {
        const layer = document.querySelector('.font-morph-layer')
        if (!(layer instanceof HTMLCanvasElement)) return null
        const pixels = layer.getContext('2d')?.getImageData(0, 0, layer.width, layer.height).data
        if (!pixels) return null
        let alphaPixels = 0
        let minX = layer.width
        let minY = layer.height
        let maxX = -1
        let maxY = -1
        let hash = 2_166_136_261
        for (let pixel = 0; pixel < pixels.length / 4; pixel += 1) {
          const alpha = pixels[pixel * 4 + 3]
          hash = Math.imul(hash ^ alpha, 16_777_619) >>> 0
          if (!alpha) continue
          alphaPixels += 1
          const x = pixel % layer.width
          const y = Math.floor(pixel / layer.width)
          minX = Math.min(minX, x)
          minY = Math.min(minY, y)
          maxX = Math.max(maxX, x)
          maxY = Math.max(maxY, y)
        }
        const endpoint = document.querySelector('[data-font-morph="sample"]')
        return {
          renderer: layer.dataset.fontMorphRenderer,
          hash,
          alphaPixels,
          inkBounds: { minX, minY, maxX, maxY },
          canvas: { width: layer.width, height: layer.height },
          endpoint: endpoint?.getBoundingClientRect().toJSON(),
          active: document.documentElement.dataset.fontMorphActive,
        }
      }),
    )
    await page.waitForTimeout(65)
  }

  // Resizing a real browser can outlast the fixture's animation on slower CI
  // machines. Completed frames are valid; inspect every sample captured while
  // the morph layer was still active.
  const activeSamples = samples.filter(Boolean)
  assert(activeSamples.length >= 5, 'the live morph should expose enough frames to inspect')
  assert(
    activeSamples.every((sample) => sample.renderer === 'sdf' && sample.alphaPixels > 0),
    'every active distance-field frame should contain visible ink',
  )
  assert(
    new Set(activeSamples.map((sample) => sample.hash)).size >= 4,
    'distance fields should interpolate across frames',
  )
  assert(
    activeSamples.some((sample) => sample.canvas.width === 900) &&
      activeSamples.some((sample) => sample.canvas.width === 760),
    'the renderer should resize with the viewport during the transition',
  )
  assert(
    new Set(activeSamples.map((sample) => sample.inkBounds.minX)).size >= 3,
    'the interpolated ink should track a destination that moves during the transition',
  )
  assert(
    activeSamples.every(
      (sample) => sample.inkBounds.maxX >= sample.inkBounds.minX,
    ),
    'every rendered frame should retain a non-empty ink box',
  )

  await page.waitForFunction(() => !document.querySelector('.font-morph-layer'), null, {
    timeout: 20_000,
  })
  const settled = await page.evaluate(() => {
    const endpoint = document.querySelector('[data-font-morph="sample"]')
    return {
      className: endpoint?.className,
      active: document.documentElement.hasAttribute('data-font-morph-active'),
      fallback: document.documentElement.hasAttribute('data-font-morph-fallback'),
      events: window.fontMorphFixture.events.length,
    }
  })
  assert.match(settled.className ?? '', /serif/)
  assert.equal(settled.active, false)
  assert.equal(settled.fallback, false)
  assert.equal(settled.events, 1, 'a completed morph should emit one semantic event')
  assert(
    Math.abs(
      (await page.evaluate(() => window.fontMorphFixture.events[0].source.style.baselineToHeight)) -
        sourceBaselineRatio,
    ) < 0.001,
    'recorded geometry should use the DOM baseline of a fallback-font run',
  )
  assert.doesNotMatch(
    JSON.stringify(await page.evaluate(() => window.fontMorphFixture.events[0])),
    /distanceBase64|glyphs|sdfMorphs/,
    'recordings should contain only the semantic transition event, never build geometry',
  )
  assert.equal(requests.get('/sans-outline.otf') ?? 0, 0, 'forward morph should use prepared data')

  // The tracking assertion above deliberately moved the destination to an
  // uncompiled optical size. Restore the compiled endpoint before exercising
  // the reverse prepared-data path; worker fallback is tested separately.
  await page.evaluate(() =>
    {
      document.documentElement.style.setProperty('--font-morph-duration', '1600ms')
      document.querySelector('[data-font-morph="sample"]')?.classList.remove('moved')
    },
  )
  const reverseStarted = await page.evaluate(() => {
    const snapshot = () => {
      const endpoint = document.querySelector('[data-font-morph="sample"]')
      return {
        opacity: endpoint?.style.getPropertyValue('opacity'),
        priority: endpoint?.style.getPropertyPriority('opacity'),
        computedOpacity: endpoint ? getComputedStyle(endpoint).opacity : undefined,
      }
    }
    window.__fontMorphSettlement = new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (document.documentElement.hasAttribute('data-font-morph-active')) return
        observer.disconnect()
        const immediate = snapshot()
        requestAnimationFrame(() => {
          const firstPaint = snapshot()
          requestAnimationFrame(() => resolve({ immediate, firstPaint, restored: snapshot() }))
        })
      })
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-font-morph-active'],
      })
    })
    return window.fontMorphFixture.reverse()
  })
  assert.equal(reverseStarted, true)
  await page.waitForSelector('.font-morph-layer[data-font-morph-renderer="sdf"]', {
    state: 'attached',
  })
  await page.waitForFunction(() => !document.querySelector('.font-morph-layer'), null, {
    timeout: 3_000,
  })
  assert.equal(
    await page.evaluate(() => document.querySelector('[data-font-morph="sample"]')?.classList.contains('sans')),
    true,
    'the same routine should morph in both font directions',
  )
  const settlementHandoff = await page.evaluate(() => window.__fontMorphSettlement)
  assert.deepEqual(
    settlementHandoff.immediate,
    { opacity: '1', priority: 'important', computedOpacity: '1' },
    'the destination must be explicitly visible before compositor effects are cancelled',
  )
  assert.deepEqual(
    settlementHandoff.firstPaint,
    { opacity: '1', priority: 'important', computedOpacity: '1' },
    'the destination visibility lock must span one painted frame',
  )
  assert.deepEqual(
    settlementHandoff.restored,
    { opacity: '', priority: '', computedOpacity: '1' },
    'the destination must restore its authored opacity after the safe handoff',
  )
  const reverseTargetBaselineRatio = await page.evaluate(
    () => window.fontMorphFixture.events[1]?.target.style.baselineToHeight,
  )
  assert(
    Math.abs(reverseTargetBaselineRatio - sourceBaselineRatio) < 0.001,
    'the reverse destination must retain the browser-defined fallback-font baseline',
  )
  assert.equal(requests.get('/sans-outline.otf') ?? 0, 0, 'reverse morph should use prepared data')

  await page.evaluate(async () => {
    window.fontMorphFixture.show('serif')
    await window.fontMorphFixture.prepareReplay()
  })
  assert.equal(
    requests.get('/sans-outline.otf') ?? 0,
    0,
    `replay preparation should use prepared data: ${JSON.stringify(
      await page.evaluate(() => window.fontMorphFixture.workerRequests),
    )}`,
  )
  const replayFrameAt = (time) =>
    page.evaluate((replayTime) => {
      window.fontMorphFixture.replayAt(replayTime)
      const layer = document.querySelector('.font-morph-director-layer')
      if (!(layer instanceof HTMLCanvasElement)) return null
      const pixels = layer.getContext('2d')?.getImageData(0, 0, layer.width, layer.height).data
      if (!pixels) return null
      let alphaPixels = 0
      let hash = 2_166_136_261
      for (let pixel = 0; pixel < pixels.length / 4; pixel += 1) {
        const alpha = pixels[pixel * 4 + 3]
        hash = Math.imul(hash ^ alpha, 16_777_619) >>> 0
        if (alpha) alphaPixels += 1
      }
      const endpointOpacity = (selector) => {
        const endpoint = document.querySelector(selector)
        return endpoint
          ? {
              value: endpoint.style.getPropertyValue('opacity'),
              priority: endpoint.style.getPropertyPriority('opacity'),
            }
          : null
      }
      return {
        renderer: layer.dataset.fontMorphRenderer,
        rendererOpacity: Number(getComputedStyle(layer).opacity),
        hash,
        alphaPixels,
        sansOpacity: endpointOpacity('.endpoint.sans'),
        serifOpacity: endpointOpacity('.endpoint.serif'),
        sourceLayerOpacity: endpointOpacity('.font-morph-source-layer'),
        targetLayerOpacity: endpointOpacity('.font-morph-target-layer'),
      }
    }, time)
  const replayRoles = await page.evaluate(() => {
    const payload = window.fontMorphFixture.events.at(-1)
    return { source: payload.source.style.fontRole, target: payload.target.style.fontRole }
  })
  await page.evaluate((role) => window.fontMorphFixture.show(role), replayRoles.source)
  const openingHandoff = await replayFrameAt(2)
  const openingOpacity = openingHandoff?.sourceLayerOpacity
  assert.equal(openingOpacity?.value, '0')
  assert.equal(openingHandoff?.rendererOpacity, 1)
  assert.equal(openingHandoff?.[`${replayRoles.source}Opacity`]?.value, '0')
  assert.equal(openingHandoff?.[`${replayRoles.source}Opacity`]?.priority, 'important')
  await page.evaluate((role) => window.fontMorphFixture.show(role), replayRoles.target)
  const early = await replayFrameAt(120)
  const middle = await replayFrameAt(320)
  const late = await replayFrameAt(520)
  assert.equal(early?.renderer, 'sdf')
  assert((early?.alphaPixels ?? 0) > 0)
  assert.equal(
    await page.locator('#replay-overlay > .font-morph-blend-root > canvas.font-morph-director-layer').count(),
    1,
    'replay rendering should mount in the supplied host overlay',
  )
  assert.notDeepEqual(early, middle)
  assert.notDeepEqual(middle, late)
  await replayFrameAt(580)
  assert.deepEqual(
    await replayFrameAt(120),
    early,
    'rewinding should reconstruct distance fields solely from replay time',
  )
  const closingHandoff = await replayFrameAt(1_550)
  const closingOpacity = closingHandoff?.targetLayerOpacity
  assert.equal(closingOpacity?.value, '0')
  assert.equal(closingHandoff?.rendererOpacity, 1)
  assert.equal(closingHandoff?.[`${replayRoles.target}Opacity`]?.value, '0')
  assert.equal(closingHandoff?.[`${replayRoles.target}Opacity`]?.priority, 'important')
  await replayFrameAt(1_602)
  assert.equal(
    await page.evaluate(() =>
      document
        .querySelector(`[data-font-morph="sample"].${window.fontMorphFixture.events.at(-1).target.style.fontRole}`)
        ?.style.getPropertyValue('opacity'),
    ),
    '',
    'settlement should restore the destination endpoint without retaining replay state',
  )
  await page.evaluate(() => window.fontMorphFixture.stopReplay())
  assert.equal(await page.locator('.font-morph-director-layer').count(), 0)
  assert.equal(await page.locator('.font-morph-blend-root').count(), 0)
  assert.equal(
    requests.get('/sans-outline.otf') ?? 0,
    0,
    'prepared live and replay paths should stay off the compiler worker',
  )
  assert.equal(requests.get('/serif-outline.otf') ?? 0, 0)

  await page.evaluate(() => window.fontMorphFixture.prepareUnknown())
  assert.equal(requests.get('/sans-outline.otf'), 1, 'unknown text should use the worker fallback')
  assert.equal(requests.get('/serif-outline.otf'), 1, 'unknown text should use the worker fallback')
  assert.deepEqual(errors, [])

  console.log(`Glyphflux browser checks passed (preparation ${preparation.toFixed(1)}ms)`)
} finally {
  await closeBrowser?.()
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
}
