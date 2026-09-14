import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { createSdfTextMorphCompiler } from '../dist/compiler/index.mjs'
import { renderFontMorphSdfAlphaFrame } from '../dist/sdf-runtime/index.mjs'
import { getBrowser } from '../e2e/browser.mjs'
import { createHarfBuzzRunShaper } from '../dist/build/index.mjs'
import { fontSubsetCoverage } from '../scripts/font-subset-coverage.mjs'

const outputRoot = fileURLToPath(new URL('../demo-dist/client', import.meta.url))
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
}
const catalog = JSON.parse(await readFile(new URL('./catalog.json', import.meta.url), 'utf8'))
const regressionFixtures = JSON.parse(
  await readFile(new URL('./regression-fixtures.json', import.meta.url), 'utf8'),
)
const generatedManifest = JSON.parse(
  await readFile(resolve(outputRoot, 'generated/manifest.json'), 'utf8'),
)
const samples = Object.fromEntries(
  catalog.languages.map((language) => {
    const profile = catalog.profiles[language.profile]
    return [
      language.code,
      {
        ...language,
        captions: [profile.sourceLabel, profile.targetLabel],
      },
    ]
  }),
)
const continuityRegressionLocales = new Set([
  'ar',
  'bg',
  'bn',
  'ca',
  'el',
  'fa',
  'gl',
  'is',
  'kk',
  'pt',
  'ru',
  'sr',
  'uk',
  'ur',
  'vi',
  'yo',
])
const regressionLocales = new Set([
  'en',
  'es',
  'zh-CN',
  'zh-TW',
  'hi',
  'ja',
  'ko',
  ...continuityRegressionLocales,
])
const maximumVerticalDrift = 4

const readDemoFont = async (file, axes) => {
  const bytes = await readFile(new URL(`./public/fonts/${file}`, import.meta.url))
  return {
    data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    ...(axes ? { axes } : {}),
  }
}

const bengaliProfile = catalog.profiles.bengali
const shortBangla = regressionFixtures.find(({ id }) => id === 'bangla-repeated-vowel')
assert(shortBangla)
const banglaCoverage = fontSubsetCoverage(shortBangla.text, catalog.languages.find(({ code }) => code === 'bn').text)
assert(banglaCoverage.includes('\u09c7'), 'font coverage must include canonical Bangla decomposition parts')
assert(banglaCoverage.includes('\u09be'), 'font coverage must retain repeated Bangla vowel signs')
const banglaRegression = createSdfTextMorphCompiler(
  await readDemoFont(bengaliProfile.sourceFile, bengaliProfile.sourceAxes),
  await readDemoFont(bengaliProfile.targetFile, bengaliProfile.targetAxes),
  {
    size: 96,
    pixelsPerEm: 384,
    maximumDistance: 24,
    supersampling: 2,
    shaper: createHarfBuzzRunShaper(),
  },
).compile({
  text: shortBangla.text,
  language: shortBangla.language,
  direction: shortBangla.direction,
})
for (const run of [banglaRegression.sourceRun, banglaRegression.targetRun]) {
  assert.equal(run.script, 'Beng')
  assert.equal(
    run.glyphs.flatMap(({ codePoints }) => codePoints).filter((codePoint) => codePoint === 0x09be)
      .length,
    2,
    'the repeated Bangla vowel sign must be retained exactly twice',
  )
}
for (const pair of Object.values(banglaRegression.glyphs)) {
  const target = renderFontMorphSdfAlphaFrame(pair, 1)
  const targetSupport = new Uint8Array(target.length)
  for (let index = 0; index < target.length; index += 1) {
    if (target[index] < 16) continue
    const x = index % pair.size
    const y = Math.floor(index / pair.size)
    for (let offsetY = -2; offsetY <= 2; offsetY += 1) {
      for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
        const nextX = x + offsetX
        const nextY = y + offsetY
        if (nextX >= 0 && nextX < pair.size && nextY >= 0 && nextY < pair.size) {
          targetSupport[nextY * pair.size + nextX] = 1
        }
      }
    }
  }
  let previousDifference = Number.POSITIVE_INFINITY
  let previousOutsideTarget = Number.POSITIVE_INFINITY
  for (const progress of [0.8, 0.9, 0.97, 1]) {
    const frame = renderFontMorphSdfAlphaFrame(pair, progress)
    const difference = frame.reduce(
      (sum, alpha, index) => sum + Math.abs(alpha - target[index]),
      0,
    )
    const outsideTarget = frame.reduce(
      (sum, alpha, index) => sum + (targetSupport[index] ? 0 : alpha),
      0,
    )
    assert(
      difference <= previousDifference,
      `Bangla near-target geometry must converge monotonically at ${progress}`,
    )
    assert(
      outsideTarget <= previousOutsideTarget,
      `Bangla source-only protrusions must recede monotonically at ${progress}`,
    )
    previousDifference = difference
    previousOutsideTarget = outsideTarget
  }
}

function endpointSimilarity(liveBuffer, renderedBuffer) {
  const mask = (buffer) => {
    const image = PNG.sync.read(buffer)
    const pixels = new Uint8Array(image.width * image.height)
    for (let index = 0; index < pixels.length; index += 1) {
      pixels[index] = image.data[index * 4] < 200 ? 1 : 0
    }
    return { width: image.width, height: image.height, pixels }
  }
  const live = mask(liveBuffer)
  const rendered = mask(renderedBuffer)
  assert.equal(rendered.width, live.width)
  assert.equal(rendered.height, live.height)
  const dilate = ({ width, height, pixels }) => {
    const output = new Uint8Array(pixels.length)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (!pixels[y * width + x]) continue
        for (let offsetY = -2; offsetY <= 2; offsetY += 1) {
          for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
            const nextX = x + offsetX
            const nextY = y + offsetY
            if (nextX >= 0 && nextX < width && nextY >= 0 && nextY < height) {
              output[nextY * width + nextX] = 1
            }
          }
        }
      }
    }
    return output
  }
  const dilatedLive = dilate(live)
  const dilatedRendered = dilate(rendered)
  let liveInk = 0
  let renderedInk = 0
  let liveMatched = 0
  let renderedMatched = 0
  for (let index = 0; index < live.pixels.length; index += 1) {
    liveInk += live.pixels[index]
    renderedInk += rendered.pixels[index]
    liveMatched += live.pixels[index] && dilatedRendered[index] ? 1 : 0
    renderedMatched += rendered.pixels[index] && dilatedLive[index] ? 1 : 0
  }
  return Math.min(liveMatched / liveInk, renderedMatched / renderedInk)
}

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1)
    let file = resolve(outputRoot, relative)
    if (!file.startsWith(outputRoot)) {
      response.writeHead(404).end('Not found')
      return
    }
    const fileStat = await stat(file).catch(() => null)
    if (fileStat?.isDirectory()) file = resolve(file, 'index.html')
    if (!fileStat && !extname(file)) file = resolve(file, 'index.html')
    if (!(await stat(file).catch(() => null))?.isFile()) {
      response.writeHead(404).end('Not found')
      return
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

for (const language of catalog.languages) {
  const controlledHtml = await readFile(resolve(outputRoot, language.code, 'index.html'), 'utf8')
  const sansHtml = await readFile(
    resolve(outputRoot, language.code, 'view', 'sans', 'index.html'),
    'utf8',
  )
  const serifHtml = await readFile(
    resolve(outputRoot, language.code, 'view', 'serif', 'index.html'),
    'utf8',
  )
  assert(controlledHtml.includes(language.text), `${language.code}: controlled route must SSR text`)
  assert(sansHtml.includes(language.text), `${language.code}: sans route must SSR text`)
  assert(serifHtml.includes(language.text), `${language.code}: serif route must SSR text`)
}

function inkCenterX(buffer) {
  const image = PNG.sync.read(buffer)
  let minimum = image.width
  let maximum = -1
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const index = (y * image.width + x) * 4
      if (
        image.data[index] >= 245 &&
        image.data[index + 1] >= 245 &&
        image.data[index + 2] >= 245
      ) {
        continue
      }
      minimum = Math.min(minimum, x)
      maximum = Math.max(maximum, x)
    }
  }
  assert(maximum >= minimum, 'endpoint screenshot must contain visible ink')
  return (minimum + maximum + 1) / 2
}

async function sampleTransition(page, buttonName) {
  return page.getByRole('button', { name: buttonName }).evaluate(
    (button) =>
      new Promise((resolve) => {
        const samples = []
        const compositing = []
        const shell = []
        const started = performance.now()
        let sawRenderer = false
        let trajectoryDone = false
        let settlement = null
        const sampleCanvas = document.createElement('canvas')
        const sampleContext = sampleCanvas.getContext('2d', { willReadFrequently: true })
        const maybeResolve = () => {
          if (trajectoryDone && settlement) resolve({ samples, settlement, compositing, shell })
        }
        const endpointSnapshot = () => {
          const endpoint = document.querySelector('[data-font-morph]')
          return {
            opacity: endpoint?.style.getPropertyValue('opacity'),
            priority: endpoint?.style.getPropertyPriority('opacity'),
            computedOpacity: endpoint ? getComputedStyle(endpoint).opacity : undefined,
          }
        }
        const shellSnapshot = () =>
          ['.eyebrow', '.demo-header h1', 'select', '.demo-switch-link'].map((selector) => {
            const element = document.querySelector(selector)
            const bounds = element.getBoundingClientRect()
            const style = getComputedStyle(element)
            return {
              selector,
              x: bounds.x,
              y: bounds.y,
              width: bounds.width,
              height: bounds.height,
              fontFamily: style.fontFamily,
              visibility: style.visibility,
            }
          })
        const observer = new MutationObserver(() => {
          if (document.documentElement.hasAttribute('data-font-morph-active')) return
          observer.disconnect()
          const immediate = endpointSnapshot()
          requestAnimationFrame(() => {
            const firstPaint = endpointSnapshot()
            requestAnimationFrame(() => {
              settlement = { immediate, firstPaint, restored: endpointSnapshot() }
              maybeResolve()
            })
          })
        })
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['data-font-morph-active'],
        })
        const collect = () => {
          shell.push(shellSnapshot())
          const canvas = document.querySelector('canvas[data-font-morph-renderer="sdf"]')
          if (canvas) {
            sawRenderer = true
            const sourceLayer = document.querySelector('.font-morph-source-layer')
            const targetLayer = document.querySelector('.font-morph-target-layer')
            const blendRoot = document.querySelector('.font-morph-blend-root')
            if (sourceLayer && targetLayer && blendRoot) {
              compositing.push({
                isolation: getComputedStyle(blendRoot).isolation,
                blendModes: [sourceLayer, canvas, targetLayer].map(
                  (element) => getComputedStyle(element).mixBlendMode,
                ),
                opacitySum: [sourceLayer, canvas, targetLayer].reduce(
                  (sum, element) => sum + Number.parseFloat(getComputedStyle(element).opacity),
                  0,
                ),
              })
            }
            const opacity = Number.parseFloat(getComputedStyle(canvas).opacity)
            if (opacity >= 0.05 && sampleContext) {
              const horizontalDownsample = 6
              const sampleWidth = Math.max(1, Math.ceil(canvas.width / horizontalDownsample))
              const sampleHeight = canvas.height
              if (sampleCanvas.width !== sampleWidth) sampleCanvas.width = sampleWidth
              if (sampleCanvas.height !== sampleHeight) sampleCanvas.height = sampleHeight
              sampleContext.clearRect(0, 0, sampleWidth, sampleHeight)
              sampleContext.drawImage(canvas, 0, 0, sampleWidth, sampleHeight)
              const data = sampleContext.getImageData(0, 0, sampleWidth, sampleHeight).data
              let minX = sampleWidth
              let minY = sampleHeight
              let maxX = -1
              let maxY = -1
              for (let y = 0; y < sampleHeight; y += 1) {
                for (let x = 0; x < sampleWidth; x += 1) {
                  if (data[(y * sampleWidth + x) * 4 + 3] < 16) continue
                  minX = Math.min(minX, x)
                  minY = Math.min(minY, y)
                  maxX = Math.max(maxX, x)
                  maxY = Math.max(maxY, y)
                }
              }
              if (maxX >= 0) {
                const bounds = canvas.getBoundingClientRect()
                samples.push({
                  x: bounds.left + ((minX + maxX) / 2 / sampleWidth) * bounds.width,
                  y: bounds.top + ((minY + maxY) / 2 / sampleHeight) * bounds.height,
                  time: performance.now() - started,
                })
              }
            }
          }
          const active = document.documentElement.hasAttribute('data-font-morph-active')
          if ((sawRenderer && !active) || performance.now() - started > 1_600) {
            trajectoryDone = true
            if (!settlement && performance.now() - started > 1_600) {
              observer.disconnect()
              settlement = {
                immediate: endpointSnapshot(),
                firstPaint: endpointSnapshot(),
                restored: endpointSnapshot(),
              }
            }
            maybeResolve()
            return
          }
          requestAnimationFrame(collect)
        }
        button.click()
        requestAnimationFrame(collect)
      }),
  )
}

function assertStableShell(samples, label) {
  assert(samples.length > 1, `${label}: must sample the shared interface`)
  const first = samples[0]
  for (const sample of samples.slice(1)) {
    assert.deepEqual(sample, first, `${label}: shared header, locale control, and footer must not flicker`)
  }
  for (const item of first) {
    assert.equal(item.visibility, 'visible', `${label}: ${item.selector} must remain visible`)
    assert.equal(
      item.fontFamily.includes('Glyphflux'),
      false,
      `${label}: ${item.selector} must not depend on an asynchronously loaded morph font`,
    )
  }
}

function assertSmoothTrajectory(samples, label) {
  assert(samples.length >= 8, `${label}: must expose enough rendered animation frames`)
  const direction = Math.sign(samples.at(-1).x - samples[0].x) || 1
  const total = Math.abs(samples.at(-1).x - samples[0].x)
  let largestStep = 0
  for (let index = 1; index < samples.length; index += 1) {
    const step = samples[index].x - samples[index - 1].x
    assert(direction * step >= -3, `${label}: horizontal motion must not reverse or teleport`)
    const elapsed = Math.max(1, samples[index].time - samples[index - 1].time)
    const normalizedStep = (Math.abs(step) * 16.7) / elapsed
    largestStep = Math.max(largestStep, normalizedStep)
  }
  assert(
    largestStep <= Math.max(12, total * 0.35),
    `${label}: no frame may teleport at normal frame cadence (${JSON.stringify({ largestStep, total, samples })})`,
  )
  const vertical = samples.map(({ y }) => y)
  const verticalRange = Math.max(...vertical) - Math.min(...vertical)
  assert(
    verticalRange <= maximumVerticalDrift,
    `${label}: ink must stay centered (${JSON.stringify({ verticalRange, samples })})`,
  )
}

function assertWeightPreservingHandoff(compositing, label) {
  assert(compositing.length >= 2, `${label}: must expose composited handoff frames`)
  for (const frame of compositing) {
    assert.equal(frame.isolation, 'isolate', `${label}: handoff must use an isolated blend group`)
    assert.deepEqual(
      frame.blendModes,
      ['plus-lighter', 'plus-lighter', 'plus-lighter'],
      `${label}: every handoff layer must use additive premultiplied blending`,
    )
    assert(
      Math.abs(frame.opacitySum - 1) <= 0.025,
      `${label}: handoff coverage weights must sum to one (${frame.opacitySum})`,
    )
  }
}

function assertContinuousSettlement(settlement, label) {
  assert.deepEqual(
    settlement.immediate,
    { opacity: '1', priority: 'important', computedOpacity: '1' },
    `${label}: destination must be pinned before compositor cleanup`,
  )
  assert.deepEqual(
    settlement.firstPaint,
    { opacity: '1', priority: 'important', computedOpacity: '1' },
    `${label}: destination must remain visible for the first settled paint`,
  )
  assert.deepEqual(
    settlement.restored,
    { opacity: '', priority: '', computedOpacity: '1' },
    `${label}: destination must restore its authored opacity`,
  )
}

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
const address = server.address()
assert(address && typeof address !== 'string')

const errors = []
const { browser, close } = await getBrowser()
try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 720 } })
  const page = await context.newPage()
  const generatedRequests = []
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (pathname.startsWith('/generated/')) generatedRequests.push(pathname)
  })
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto(`http://127.0.0.1:${address.port}/en`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-demo-status="ready"]')
  await page.evaluate(() => document.fonts.ready)
  assert.equal(
    await page.locator('canvas.font-morph-progress-layer[data-font-morph-renderer="sdf"]').count(),
    1,
    'the controlled demo must dogfood the public progress controller and prepared SDF renderer',
  )
  assert.deepEqual(generatedRequests, [
    '/generated/manifest.json',
    '/generated/pairs/latin.json',
  ])

  const setProgress = async (locale, value) => {
    const progress = value / 1000
    const previous = await page
      .locator('[data-font-morph-sdf]')
      .getAttribute('data-font-morph-sdf-frame')
    if (Number(await page.locator('#progress').inputValue()) === value) {
      await page.waitForFunction(
        ([expectedLocale, expectedProgress]) =>
          document
            .querySelector('[data-font-morph-sdf]')
            ?.dataset.fontMorphSdfFrame?.startsWith(`${expectedLocale}:${expectedProgress}:`),
        [locale, progress],
      )
      return
    }
    await page.locator('#progress').evaluate((element, next) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(element, String(next))
      element.dispatchEvent(new Event('input', { bubbles: true }))
    }, value)
    await page.waitForFunction(
      ([expectedLocale, expectedProgress, prior]) => {
        const marker = document.querySelector('[data-font-morph-sdf]')?.dataset.fontMorphSdfFrame
        return marker?.startsWith(`${expectedLocale}:${expectedProgress}:`) && marker !== prior
      },
      [locale, progress, previous],
    )
    await page.evaluate(
      () =>
        new Promise((resolveFrame) =>
          requestAnimationFrame(() => requestAnimationFrame(resolveFrame)),
        ),
    )
  }

  const frame = (targetPage = page) =>
    targetPage.evaluate(async () => {
      const canvas = document.querySelector('[data-font-morph-sdf]')
      const context = canvas.getContext('2d')
      const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data
      const alpha = Uint8Array.from({ length: rgba.length / 4 }, (_, index) => rgba[index * 4 + 3])
      const digest = await crypto.subtle.digest('SHA-256', alpha)
      let minX = canvas.width
      let minY = canvas.height
      let maxX = -1
      let maxY = -1
      for (let index = 0; index < alpha.length; index += 1) {
        if (!alpha[index]) continue
        const x = index % canvas.width
        const y = Math.floor(index / canvas.width)
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
      const bounds = canvas.getBoundingClientRect()
      const ratioX = bounds.width / canvas.width
      const ratioY = bounds.height / canvas.height
      return {
        hash: [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join(''),
        inkPixels: alpha.filter(Boolean).length,
        inkBounds:
          maxX < 0
            ? null
            : {
                left: bounds.left + minX * ratioX,
                top: bounds.top + minY * ratioY,
                right: bounds.left + (maxX + 1) * ratioX,
                bottom: bounds.top + (maxY + 1) * ratioY,
              },
      }
    })

  const compareEndpoint = async (selector, locale, value) => {
    await setProgress(locale, value)
    const bounds = await page.locator(selector).boundingBox()
    assert(bounds)
    const viewport = page.viewportSize()
    assert(viewport)
    const padding = 8
    const clip = {
      x: Math.max(0, bounds.x - padding),
      y: Math.max(0, bounds.y - padding),
      width:
        Math.min(viewport.width, bounds.x + bounds.width + padding) -
        Math.max(0, bounds.x - padding),
      height:
        Math.min(viewport.height, bounds.y + bounds.height + padding) -
        Math.max(0, bounds.y - padding),
    }
    await page.evaluate((selected) => {
      document.querySelector('[data-font-morph-sdf]').style.visibility = 'hidden'
      for (const endpoint of document.querySelectorAll('[data-demo-endpoint]')) {
        endpoint.style.opacity = endpoint.matches(selected) ? '1' : '0'
      }
      for (const endpoint of document.querySelectorAll('[data-demo-exact-endpoint]')) {
        endpoint.style.visibility = 'hidden'
      }
    }, selector)
    const live = await page.screenshot({ clip })
    await page.evaluate(() => {
      const renderer = document.querySelector('[data-font-morph-sdf]')
      renderer.style.visibility = 'visible'
      for (const endpoint of document.querySelectorAll('[data-demo-endpoint]')) {
        endpoint.style.opacity = '0'
      }
      for (const endpoint of document.querySelectorAll('[data-demo-exact-endpoint]')) {
        endpoint.style.removeProperty('visibility')
      }
    })
    const rendered = await page.screenshot({ clip })
    await page.evaluate(() => {
      const renderer = document.querySelector('[data-font-morph-sdf]')
      renderer.style.removeProperty('visibility')
      for (const endpoint of document.querySelectorAll('[data-demo-endpoint]')) {
        endpoint.style.removeProperty('opacity')
      }
      for (const endpoint of document.querySelectorAll('[data-demo-exact-endpoint]')) {
        endpoint.style.removeProperty('visibility')
      }
    })
    const similarity = endpointSimilarity(live, rendered)
    if (!live.equals(rendered)) {
      const kind = value === 0 ? 'source' : 'target'
      const diagnostics = fileURLToPath(new URL('../test-results/endpoints/', import.meta.url))
      await mkdir(diagnostics, { recursive: true })
      await Promise.all([
        writeFile(resolve(diagnostics, `${locale}-${kind}-browser.png`), live),
        writeFile(resolve(diagnostics, `${locale}-${kind}-glyphflux.png`), rendered),
      ])
    }
    return {
      exact: live.equals(rendered),
      similarity,
      liveInkCenterX: clip.x + inkCenterX(live),
    }
  }

  assert.equal(await page.locator('#locale option').count(), Object.keys(samples).length)
  for (const [locale, sample] of Object.entries(samples)) {
    await page.locator('#locale').selectOption(locale)
    await page.waitForFunction(
      ([expectedLocale, text]) =>
        document.querySelector('[data-demo-endpoint="source"]')?.getAttribute('lang') ===
          expectedLocale &&
        document.querySelector('[data-demo-endpoint="source"]')?.textContent === text,
      [sample.language ?? locale, sample.text],
    )
    assert.deepEqual(await page.locator('.endpoint-caption').allTextContents(), sample.captions)
    assert.equal(
      await page
        .locator('[data-demo-endpoint="source"]')
        .evaluate((element) => getComputedStyle(element).direction),
      sample.direction,
    )
    assert.equal(
      await page
        .locator('[data-demo-endpoint="source"]')
        .evaluate((element) => getComputedStyle(element).opacity),
      '0.16',
    )
    assert.equal(
      await page
        .locator('[data-demo-endpoint="target"]')
        .evaluate((element) => getComputedStyle(element).opacity),
      '0.16',
    )

    await setProgress(locale, 30)
    await setProgress(locale, 0)
    const source = await frame()
    await setProgress(locale, 30)
    const nearSource = await frame()
    await setProgress(locale, 500)
    const middle = await frame()
    await setProgress(locale, 790)
    const intermediateLayers = await page.evaluate(() => [
      Number.parseFloat(
        getComputedStyle(document.querySelector('[data-demo-exact-endpoint="source"]')).opacity,
      ),
      Number.parseFloat(getComputedStyle(document.querySelector('[data-font-morph-sdf]')).opacity),
      Number.parseFloat(
        getComputedStyle(document.querySelector('[data-demo-exact-endpoint="target"]')).opacity,
      ),
    ])
    assert.deepEqual(
      intermediateLayers,
      [0, 1, 0],
      `${locale}: t=0.79 must contain only the generated morph, without endpoint cross-fading`,
    )
    await setProgress(locale, 900)
    const late = await frame()
    await setProgress(locale, 970)
    const nearTarget = await frame()
    await setProgress(locale, 990)
    const almostTarget = await frame()
    const controlledHandoff = await page.evaluate(() => {
      const stage = document.querySelector('.stage')
      const source = document.querySelector('[data-demo-exact-endpoint="source"]')
      const renderer = document.querySelector('[data-font-morph-sdf]')
      const target = document.querySelector('[data-demo-exact-endpoint="target"]')
      return {
        isolation: getComputedStyle(stage).isolation,
        blendModes: [source, renderer, target].map(
          (element) => getComputedStyle(element).mixBlendMode,
        ),
        opacitySum: [source, renderer, target].reduce(
          (sum, element) => sum + Number.parseFloat(getComputedStyle(element).opacity),
          0,
        ),
        opacities: [source, renderer, target].map((element) =>
          Number.parseFloat(getComputedStyle(element).opacity),
        ),
      }
    })
    await setProgress(locale, 1000)
    const target = await frame()
    await setProgress(locale, 0)
    const rewound = await frame()

    for (const [name, rendered] of Object.entries({
      source,
      nearSource,
      middle,
      late,
      nearTarget,
      almostTarget,
      target,
    })) {
      assert(rendered.inkPixels > 0, `${locale}: ${name} frame must contain ink`)
      assert(rendered.inkBounds, `${locale}: ${name} frame must have measurable bounds`)
    }
    const stageBox = await page.locator('.stage').boundingBox()
    assert(stageBox)
    const stageCenterY = stageBox.y + stageBox.height / 2
    for (const [name, rendered] of Object.entries({
      source,
      nearSource,
      middle,
      late,
      nearTarget,
      almostTarget,
      target,
    })) {
      const inkCenterY = (rendered.inkBounds.top + rendered.inkBounds.bottom) / 2
      assert(
        Math.abs(inkCenterY - stageCenterY) <= 3,
        `${locale}: ${name} visible ink must remain vertically centered`,
      )
    }
    assert.notEqual(source.hash, nearSource.hash, `${locale}: t=0.03 must interpolate`)
    assert.notEqual(source.hash, middle.hash, `${locale}: midpoint must differ from the source`)
    assert.notEqual(middle.hash, target.hash, `${locale}: midpoint must differ from the target`)
    assert.notEqual(nearTarget.hash, target.hash, `${locale}: t=0.97 must interpolate`)
    assert.equal(source.hash, rewound.hash, `${locale}: rewinding must be deterministic`)
    assert.deepEqual(
      controlledHandoff.opacities,
      [0, 1, 0],
      `${locale}: near-target frames must contain only the generated morph`,
    )

    if (regressionLocales.has(locale)) {
      assert.equal(controlledHandoff.isolation, 'isolate')
      assert.deepEqual(controlledHandoff.blendModes, [
        'plus-lighter',
        'plus-lighter',
        'plus-lighter',
      ])
      assert(
        Math.abs(controlledHandoff.opacitySum - 1) <= 0.001,
        `${locale}: controlled endpoint handoff must preserve apparent weight`,
      )
      const sourceBox = await page.locator('[data-demo-endpoint="source"]').boundingBox()
      const targetBox = await page.locator('[data-demo-endpoint="target"]').boundingBox()
      const liveInkCenterY = (selector) =>
        page.locator(selector).evaluate((element) => {
          const bounds = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          const fontSize = Number.parseFloat(style.fontSize)
          const context = document.createElement('canvas').getContext('2d')
          if (!context) throw new Error('Canvas text measurement is unavailable')
          context.font = [
            style.fontStyle === 'normal' ? '' : style.fontStyle,
            style.fontVariantCaps === 'normal' ? '' : style.fontVariantCaps,
            style.fontWeight === 'normal' || style.fontWeight === '400'
              ? ''
              : style.fontWeight,
            style.fontStretch === 'normal' || style.fontStretch === '100%'
              ? ''
              : style.fontStretch,
            style.fontSize,
            style.fontFamily,
          ]
            .filter(Boolean)
            .join(' ')
          context.direction = style.direction
          context.fontKerning = style.fontKerning
          context.fontStretch = style.fontStretch
          context.fontVariantCaps = style.fontVariantCaps
          context.letterSpacing = style.letterSpacing
          context.wordSpacing = style.wordSpacing
          const metrics = context.measureText(element.textContent ?? '')
          const marker = document.createElement('i')
          marker.style.cssText =
            'display:inline-block;width:0;height:0;margin:0;padding:0;border:0;vertical-align:baseline;'
          element.append(marker)
          const baseline = marker.getBoundingClientRect().top
          marker.remove()
          return baseline + (metrics.actualBoundingBoxDescent - metrics.actualBoundingBoxAscent) / 2
        })
      const sourceLiveCenterY = await liveInkCenterY('[data-demo-endpoint="source"]')
      const targetLiveCenterY = await liveInkCenterY('[data-demo-endpoint="target"]')
      const center = (bounds) => ({
        x: (bounds.left + bounds.right) / 2,
        y: (bounds.top + bounds.bottom) / 2,
      })
      assert(sourceBox && targetBox && source.inkBounds && target.inkBounds)
      const sourceCenter = center(source.inkBounds)
      const targetCenter = center(target.inkBounds)
      assert(
        Math.abs(sourceCenter.y - sourceLiveCenterY) <= 3,
        `${locale}: t=0 must align with the source text: ${JSON.stringify({ sourceCenter, sourceBox, sourceLiveCenterY })}`,
      )
      assert(
        Math.abs(targetCenter.y - targetLiveCenterY) <= 3,
        `${locale}: t=1 must align with the target text: ${JSON.stringify({ targetCenter, targetBox, targetLiveCenterY })}`,
      )
      const sourceSimilarity = await compareEndpoint('[data-demo-endpoint="source"]', locale, 0)
      assert(
        sourceSimilarity.exact,
        `${locale}: t=0 must be pixel-identical to the browser-rendered source glyphs (${sourceSimilarity.similarity.toFixed(3)})`,
      )
      const targetSimilarity = await compareEndpoint(
        '[data-demo-endpoint="target"]',
        locale,
        1000,
      )
      assert(
        Math.abs(sourceCenter.x - sourceSimilarity.liveInkCenterX) <= 2,
        `${locale}: t=0 generated ink must share the source glyphs' horizontal center`,
      )
      assert(
        Math.abs(targetCenter.x - targetSimilarity.liveInkCenterX) <= 2,
        `${locale}: t=1 generated ink must share the target glyphs' horizontal center`,
      )
      assert(
        targetSimilarity.exact,
        `${locale}: t=1 must be pixel-identical to the browser-rendered target glyphs (${targetSimilarity.similarity.toFixed(3)})`,
      )
    }
  }

  const profileOrder = [...new Set(catalog.languages.map(({ profile }) => profile))]
  assert.deepEqual(
    generatedRequests,
    [
      '/generated/manifest.json',
      '/generated/pairs/latin.json',
      ...profileOrder
        .filter((profile) => profile !== 'latin')
        .map((profile) => `/generated/pairs/${profile}.json`),
    ],
    'each exact font profile should load once and only when its first language is selected',
  )

  const catalan = generatedManifest.samples.ca.sourceRun.glyphs
  const repeatedKeys = new Map()
  for (const glyph of catalan) {
    if (!glyph.unicode) continue
    const keys = repeatedKeys.get(glyph.unicode) ?? new Set()
    keys.add(glyph.key)
    repeatedKeys.set(glyph.unicode, keys)
  }
  assert.equal(repeatedKeys.get('a')?.size, 1, 'repeated Catalan a glyphs must share one cache key')
  assert.equal(repeatedKeys.get('l')?.size, 1, 'repeated Catalan l glyphs must share one cache key')

  await page.goto(`http://127.0.0.1:${address.port}/en/view/sans`, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  assert.equal(await page.locator('.demo-header h1').textContent(), 'View transition')
  assert.equal(await page.locator('#view-locale option').count(), Object.keys(samples).length)
  await page.locator('#view-locale').selectOption('es')
  await page.waitForURL('**/es/view/sans')
  assert.equal(await page.locator('#view-locale').inputValue(), 'es')
  await page.locator('#view-locale').selectOption('en')
  await page.waitForURL('**/en/view/sans')
  const desktopSourceHeading = await page.locator('.view-heading').boundingBox()
  await page.getByRole('button', { name: 'Morph to Serif' }).click()
  await page.waitForURL('**/en/view/serif')
  await page.waitForSelector('[data-font-morph-renderer="sdf"]')
  await page.waitForFunction(() => !document.querySelector('[data-font-morph-renderer]'))
  assert.equal(await page.locator('[data-view-demo]').getAttribute('data-view-demo'), 'serif')
  const desktopTargetHeading = await page.locator('.view-heading').boundingBox()
  assert(desktopSourceHeading && desktopTargetHeading)
  assert(
    Math.abs(
      desktopTargetHeading.x +
        desktopTargetHeading.width / 2 -
        (desktopSourceHeading.x + desktopSourceHeading.width / 2),
    ) >= 250,
    'desktop view-transition endpoints must be visually distinct',
  )
  await page.getByRole('button', { name: 'Morph to Sans serif' }).click()
  await page.waitForURL('**/en/view/sans')
  await page.waitForSelector('[data-font-morph-renderer="sdf"]')
  await page.waitForFunction(() => !document.querySelector('[data-font-morph-renderer]'))
  assert.equal(await page.locator('[data-view-demo]').getAttribute('data-view-demo'), 'sans')

  assert.deepEqual(errors, [])
  console.log(`Glyphflux demo checks passed for all ${catalog.languages.length} languages`)
  await context.close()

  const cold = await browser.newContext({ viewport: { width: 1000, height: 720 } })
  const coldPage = await cold.newPage()
  coldPage.on('pageerror', (error) => errors.push(error.message))
  coldPage.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await coldPage.route('**/fonts/*.ttf', async (route) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
    await route.continue()
  })
  await coldPage.goto(`http://127.0.0.1:${address.port}/en/view/sans`, {
    waitUntil: 'domcontentloaded',
  })
  assert.equal(await coldPage.locator('link[rel="preload"][as="font"]').count(), 2)
  const refreshFrames = await coldPage.locator('.view-heading').evaluate(
    () =>
      new Promise((resolveFrames) => {
        const frames = []
        let centeredFrames = 0
        const sample = () => {
          const shell = ['.eyebrow', '.demo-header h1', 'select', '.demo-switch-link'].map(
            (selector) => {
              const element = document.querySelector(selector)
              const bounds = element.getBoundingClientRect()
              return {
                selector,
                x: bounds.x,
                y: bounds.y,
                width: bounds.width,
                height: bounds.height,
                fontFamily: getComputedStyle(element).fontFamily,
                visibility: getComputedStyle(element).visibility,
              }
            },
          )
          const specimen = document.querySelector('.view-heading')
          const bounds = specimen.getBoundingClientRect()
          const centered = specimen.hasAttribute('data-demo-ink-centered')
          frames.push({
            shell,
            specimen: {
              x: bounds.x,
              y: bounds.y,
              width: bounds.width,
              height: bounds.height,
              visibility: getComputedStyle(specimen).visibility,
              centered,
            },
          })
          centeredFrames = centered ? centeredFrames + 1 : 0
          if (centeredFrames >= 5 || frames.length >= 120) resolveFrames(frames)
          else requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      }),
  )
  assertStableShell(
    refreshFrames.map(({ shell }) => shell),
    'cold refresh',
  )
  const visibleSpecimens = refreshFrames
    .map(({ specimen }) => specimen)
    .filter(({ visibility }) => visibility === 'visible')
  assert(visibleSpecimens.length >= 5, 'cold refresh: the centered specimen must become visible')
  assert(
    refreshFrames.some(({ specimen }) => specimen.visibility === 'hidden'),
    'cold refresh: provisional font metrics must remain hidden',
  )
  assert(
    visibleSpecimens.every(({ centered }) => centered),
    'cold refresh: the specimen must never be visible before exact ink centering',
  )
  assert.deepEqual(
    visibleSpecimens.map(({ centered: _centered, visibility: _visibility, ...bounds }) => bounds),
    visibleSpecimens.map(() => {
      const { centered: _centered, visibility: _visibility, ...bounds } = visibleSpecimens[0]
      return bounds
    }),
    'cold refresh: the visible specimen must not teleport after its first paint',
  )
  assert.deepEqual(errors, [])
  await cold.close()

  const interrupted = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const interruptedPage = await interrupted.newPage()
  interruptedPage.on('pageerror', (error) => errors.push(error.message))
  interruptedPage.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await interruptedPage.goto(`http://127.0.0.1:${address.port}/en/view/sans`, {
    waitUntil: 'networkidle',
  })
  await interruptedPage.waitForSelector('.view-heading[data-demo-ink-centered]')
  await interruptedPage.getByRole('button', { name: 'Morph to Serif' }).click()
  await interruptedPage.waitForURL('**/en/view/serif')
  await interruptedPage.waitForSelector('[data-font-morph-renderer="sdf"]')
  await interruptedPage.reload({ waitUntil: 'domcontentloaded' })
  const interruptedRefresh = await interruptedPage.evaluate(() => ({
    path: window.location.pathname,
    role: document.querySelector('[data-view-demo]')?.getAttribute('data-view-demo'),
    headingClass: document.querySelector('.view-heading')?.className,
    snapshot: document.documentElement.dataset.demoRefreshFrame,
    activeMorph: document.documentElement.hasAttribute('data-font-morph-active'),
  }))
  assert.equal(interruptedRefresh.path, '/en/view/serif')
  assert.equal(interruptedRefresh.role, 'serif')
  assert.match(interruptedRefresh.headingClass, /\bserif\b/)
  assert.equal(interruptedRefresh.snapshot, 'view')
  assert.equal(
    interruptedRefresh.activeMorph,
    false,
    'interrupted refresh: first paint must settle to the URL endpoint, not resume the morph',
  )
  await interruptedPage.waitForSelector('.view-heading[data-demo-ink-centered]')
  await interruptedPage.waitForFunction(() => !document.documentElement.dataset.demoRefreshFrame)
  assert.deepEqual(errors, [])
  await interrupted.close()

  const persisted = await browser.newContext({ viewport: { width: 1000, height: 720 } })
  await persisted.addInitScript(() => {
    window.localStorage.setItem('glyphflux:controlled-progress', '0.79')
  })
  const persistedPage = await persisted.newPage()
  persistedPage.on('pageerror', (error) => errors.push(error.message))
  persistedPage.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await persistedPage.route('**/fonts/*.ttf', async (route) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
    await route.continue()
  })
  await persistedPage.goto(`http://127.0.0.1:${address.port}/en`, {
    waitUntil: 'domcontentloaded',
  })
  await persistedPage.waitForSelector('[data-demo-status="ready"]')
  await persistedPage.waitForFunction(() => {
    const stored = JSON.parse(window.localStorage.getItem('glyphflux:refresh-frame') ?? 'null')
    return stored?.version === 2 && stored.kind === 'controlled'
  })
  const persistedCdp = await persisted.newCDPSession(persistedPage)
  await persistedCdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  await persistedPage.reload({ waitUntil: 'domcontentloaded' })
  const persistedFrames = await persistedPage.locator('main.demo').evaluate(
    () =>
      new Promise((resolveFrames) => {
        const frames = []
        let settledFrames = 0
        const sample = () => {
          const main = document.querySelector('main.demo')
          const endpointRow = document.querySelector('.endpoint-row')
          const progressControl = document.querySelector('.progress-control')
          const renderer = document.querySelector('[data-font-morph-sdf]')
          const root = document.documentElement
          const pseudo = getComputedStyle(root, '::after')
          const stage = document.querySelector('.stage').getBoundingClientRect()
          const frame = {
            ready: main.dataset.demoStatus === 'ready',
            snapshot: root.dataset.demoRefreshFrame ?? '',
            endpointVisibility: getComputedStyle(endpointRow).visibility,
            progressVisibility: getComputedStyle(progressControl).visibility,
            value: document.querySelector('#progress').value,
            output: document.querySelector('output').textContent,
            persistedOutput: getComputedStyle(document.querySelector('output'), '::after')
              .content,
            snapshotBox: {
              left: Number.parseFloat(pseudo.left),
              top: Number.parseFloat(pseudo.top),
              width: Number.parseFloat(pseudo.width),
              height: Number.parseFloat(pseudo.height),
            },
            stageBox: {
              left: stage.left,
              top: stage.top,
              width: stage.width,
              height: stage.height,
            },
            rendererVisibility: renderer ? getComputedStyle(renderer).visibility : 'missing',
            rendererFrame: renderer?.dataset.fontMorphSdfFrame ?? '',
            status: document.querySelector('.status').textContent,
          }
          frames.push(frame)
          settledFrames = frame.ready && !frame.snapshot ? settledFrames + 1 : 0
          if (settledFrames >= 5 || frames.length >= 120) resolveFrames(frames)
          else requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      }),
  )
  assert(
    persistedFrames.some(({ snapshot }) => snapshot === 'controlled'),
    'controlled refresh: the saved specimen must cover font preparation',
  )
  for (const frame of persistedFrames) {
    assert.equal(frame.status, '', 'controlled refresh: preparation must not add status copy')
    assert.equal(frame.progressVisibility, 'visible')
    if (frame.snapshot === 'controlled') {
      assert.equal(frame.endpointVisibility, 'hidden')
      assert.equal(frame.value, '790')
      assert.equal(frame.persistedOutput, '"79%"')
      for (const edge of ['left', 'top', 'width', 'height']) {
        assert(
          Math.abs(frame.snapshotBox[edge] - frame.stageBox[edge]) <= 0.01,
          `controlled refresh: snapshot ${edge} must follow the live stage`,
        )
      }
      continue
    }
    if (!frame.ready) continue
    assert.equal(frame.endpointVisibility, 'visible')
    assert.equal(frame.rendererVisibility, 'visible')
    assert.equal(frame.value, '790')
    assert.equal(frame.output, '79%')
    assert(
      frame.rendererFrame.startsWith('en:0.79:'),
      'controlled refresh: the first visible interpolated frame must use persisted progress',
    )
  }
  assert.deepEqual(errors, [])
  await persisted.close()

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const mobilePage = await mobile.newPage()
  mobilePage.on('pageerror', (error) => errors.push(error.message))
  mobilePage.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await mobilePage.goto(`http://127.0.0.1:${address.port}/en`, { waitUntil: 'networkidle' })
  await mobilePage.waitForSelector('[data-demo-status="ready"]')
  await mobilePage.evaluate(() => document.fonts.ready)
  const mobileCenters = await mobilePage.evaluate(() => {
    const inkCenter = (selector) => {
      const element = document.querySelector(selector)
      const style = getComputedStyle(element)
      const context = document.createElement('canvas').getContext('2d')
      context.font = [
        style.fontStyle === 'normal' ? '' : style.fontStyle,
        style.fontVariantCaps === 'normal' ? '' : style.fontVariantCaps,
        style.fontWeight === 'normal' || style.fontWeight === '400' ? '' : style.fontWeight,
        style.fontStretch === 'normal' || style.fontStretch === '100%'
          ? ''
          : style.fontStretch,
        style.fontSize,
        style.fontFamily,
      ]
        .filter(Boolean)
        .join(' ')
      context.direction = style.direction
      context.fontKerning = style.fontKerning
      context.fontStretch = style.fontStretch
      context.fontVariantCaps = style.fontVariantCaps
      context.letterSpacing = style.letterSpacing
      context.wordSpacing = style.wordSpacing
      const metrics = context.measureText(element.textContent ?? '')
      const marker = document.createElement('i')
      marker.style.cssText =
        'display:inline-block;width:0;height:0;margin:0;padding:0;border:0;vertical-align:baseline;'
      element.append(marker)
      const baseline = marker.getBoundingClientRect().top
      marker.remove()
      return baseline + (metrics.actualBoundingBoxDescent - metrics.actualBoundingBoxAscent) / 2
    }
    const stage = document.querySelector('.stage').getBoundingClientRect()
    return {
      stage: stage.top + stage.height / 2,
      source: inkCenter('[data-demo-endpoint="source"]'),
      target: inkCenter('[data-demo-endpoint="target"]'),
    }
  })
  assert(Math.abs(mobileCenters.source - mobileCenters.stage) <= 1)
  assert(Math.abs(mobileCenters.target - mobileCenters.stage) <= 1)
  await mobilePage.locator('#progress').fill('790')
  await mobilePage.waitForFunction(() => {
    const stored = JSON.parse(window.localStorage.getItem('glyphflux:refresh-frame') ?? 'null')
    return stored?.version === 2 && stored.progress === 0.79
  })
  await mobilePage.setViewportSize({ width: 390, height: 780 })
  await mobilePage.reload({ waitUntil: 'domcontentloaded' })
  const mobileRefresh = await mobilePage.evaluate(() => {
    const stage = document.querySelector('.stage').getBoundingClientRect()
    const pseudo = getComputedStyle(document.documentElement, '::after')
    return {
      snapshot: document.documentElement.dataset.demoRefreshFrame,
      stage: [stage.left, stage.top, stage.width, stage.height],
      restored: [pseudo.left, pseudo.top, pseudo.width, pseudo.height].map(Number.parseFloat),
    }
  })
  assert.equal(mobileRefresh.snapshot, 'controlled')
  assert.deepEqual(
    mobileRefresh.restored,
    mobileRefresh.stage,
    'mobile refresh: the saved specimen must follow the current stage, not the old viewport',
  )
  await mobilePage.waitForSelector('[data-demo-status="ready"]')
  await mobilePage.waitForFunction(() => !document.documentElement.dataset.demoRefreshFrame)
  for (const locale of regressionLocales) {
    await mobilePage.locator('#locale').selectOption(locale)
    await mobilePage.waitForFunction(
      (expectedLocale) =>
        document
          .querySelector('[data-font-morph-sdf]')
          ?.dataset.fontMorphSdfFrame?.startsWith(`${expectedLocale}:`),
      locale,
    )
    for (const value of [0, 30, 500, 900, 970, 990, 1000]) {
      await mobilePage.locator('#progress').evaluate((element, next) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter?.call(element, String(next))
        element.dispatchEvent(new Event('input', { bubbles: true }))
      }, value)
      await mobilePage.waitForFunction(
        ([expectedLocale, expectedProgress]) =>
          document
            .querySelector('[data-font-morph-sdf]')
            ?.dataset.fontMorphSdfFrame?.startsWith(`${expectedLocale}:${expectedProgress}:`),
        [locale, value / 1000],
      )
      const rendered = await frame(mobilePage)
      const stage = await mobilePage.locator('.stage').boundingBox()
      assert(rendered.inkBounds && stage)
      const inkCenterY = (rendered.inkBounds.top + rendered.inkBounds.bottom) / 2
      assert(
        Math.abs(inkCenterY - (stage.y + stage.height / 2)) <= 3,
        `${locale}: mobile ${value / 10}% visible ink must remain vertically centered`,
      )
    }
  }
  await mobilePage.locator('#locale').selectOption('en')
  await mobilePage.waitForURL('**/en')
  await mobilePage.waitForFunction(() =>
    document
      .querySelector('[data-font-morph-sdf]')
      ?.dataset.fontMorphSdfFrame?.startsWith('en:'),
  )
  const controlledFooter = await mobilePage.locator('.demo-switch-link').boundingBox()
  await mobilePage.getByRole('link', { name: 'See the view transition demo' }).click()
  await mobilePage.waitForURL('**/en/view/sans')
  const viewFooter = await mobilePage.locator('.demo-switch-link').boundingBox()
  assert(controlledFooter && viewFooter)
  assert.equal(
    controlledFooter.y,
    viewFooter.y,
    'mobile demo-switch links must retain the same vertical anchor',
  )
  const mobileSourceHeading = await mobilePage.locator('.view-heading').boundingBox()
  const sourceButton = await mobilePage.getByRole('button', { name: 'Morph to Serif' }).boundingBox()
  const forward = await sampleTransition(mobilePage, 'Morph to Serif')
  await mobilePage.waitForURL('**/en/view/serif')
  const mobileTargetHeading = await mobilePage.locator('.view-heading').boundingBox()
  assert(mobileSourceHeading && mobileTargetHeading)
  assert(
    Math.abs(
      mobileTargetHeading.x +
        mobileTargetHeading.width / 2 -
        (mobileSourceHeading.x + mobileSourceHeading.width / 2),
    ) >= 110,
    'mobile view-transition endpoints must be visually distinct',
  )
  assertSmoothTrajectory(forward.samples, 'mobile sans-to-serif transition')
  assertStableShell(forward.shell, 'mobile sans-to-serif transition')
  assertWeightPreservingHandoff(forward.compositing, 'mobile sans-to-serif transition')
  assertContinuousSettlement(forward.settlement, 'mobile sans-to-serif transition')
  const targetButton = await mobilePage
    .getByRole('button', { name: 'Morph to Sans serif' })
    .boundingBox()
  assert(sourceButton && targetButton)
  assert(
    Math.abs(
      sourceButton.x + sourceButton.width / 2 - (targetButton.x + targetButton.width / 2),
    ) <= 1,
    'mobile action must retain its horizontal anchor',
  )
  assert(
    Math.abs(sourceButton.y - targetButton.y) <= 1,
    'mobile action must retain its vertical anchor across wrapped route copy',
  )
  const reverse = await sampleTransition(mobilePage, 'Morph to Sans serif')
  await mobilePage.waitForURL('**/en/view/sans')
  assertSmoothTrajectory(reverse.samples, 'mobile serif-to-sans transition')
  assertStableShell(reverse.shell, 'mobile serif-to-sans transition')
  assertWeightPreservingHandoff(reverse.compositing, 'mobile serif-to-sans transition')
  assertContinuousSettlement(reverse.settlement, 'mobile serif-to-sans transition')
  assert.deepEqual(errors, [])
  await mobile.close()

  const wide = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const widePage = await wide.newPage()
  widePage.on('pageerror', (error) => errors.push(error.message))
  widePage.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })

  const measurePanel = async (path, mainSelector, footerText) => {
    await widePage.goto(`http://127.0.0.1:${address.port}${path}`, { waitUntil: 'networkidle' })
    await widePage.evaluate(() => document.fonts.ready)
    const main = await widePage.locator(mainSelector).boundingBox()
    const header = await widePage.locator('.demo-header').boundingBox()
    const heading = await widePage.locator('.demo-header h1').boundingBox()
    const footer = await widePage.getByRole('link', { name: footerText }).boundingBox()
    assert(main && header && heading && footer)
    for (const [label, box] of [
      ['heading', heading],
      ['footer', footer],
    ]) {
      assert(
        box.x >= header.x - 1 && box.x + box.width <= header.x + header.width + 1,
        `${path}: ${label} must remain inside the shared content bounds`,
      )
    }
    return { main, header, footer }
  }

  const controlledPanel = await measurePanel(
    '/en',
    'main.demo',
    'See the view transition demo',
  )
  const viewPanel = await measurePanel(
    '/en/view/sans',
    'main.view-demo',
    'See the controlled transition demo',
  )
  for (const key of ['x', 'width']) {
    assert(
      Math.abs(controlledPanel.main[key] - viewPanel.main[key]) <= 1,
      `desktop panels must share the same ${key}`,
    )
    assert(
      Math.abs(controlledPanel.header[key] - viewPanel.header[key]) <= 1,
      `desktop content must share the same ${key}`,
    )
  }
  assert.equal(
    controlledPanel.footer.y,
    viewPanel.footer.y,
    'desktop demo-switch links must retain the same vertical anchor',
  )
  await widePage.setViewportSize({ width: 700, height: 700 })
  const compactControlledPanel = await measurePanel(
    '/en',
    'main.demo',
    'See the view transition demo',
  )
  const compactViewPanel = await measurePanel(
    '/en/view/sans',
    'main.view-demo',
    'See the controlled transition demo',
  )
  assert.equal(
    compactControlledPanel.footer.y,
    compactViewPanel.footer.y,
    'narrow desktop demo-switch links must retain the same vertical anchor',
  )
  await widePage.setViewportSize({ width: 1440, height: 900 })
  await widePage.goto(`http://127.0.0.1:${address.port}/en/view/sans`, {
    waitUntil: 'networkidle',
  })
  const desktopForward = await sampleTransition(widePage, 'Morph to Serif')
  await widePage.waitForURL('**/en/view/serif')
  assertSmoothTrajectory(desktopForward.samples, 'desktop sans-to-serif transition')
  assertStableShell(desktopForward.shell, 'desktop sans-to-serif transition')
  assertWeightPreservingHandoff(desktopForward.compositing, 'desktop sans-to-serif transition')
  assertContinuousSettlement(desktopForward.settlement, 'desktop sans-to-serif transition')
  const desktopReverse = await sampleTransition(widePage, 'Morph to Sans serif')
  await widePage.waitForURL('**/en/view/sans')
  assertSmoothTrajectory(desktopReverse.samples, 'desktop serif-to-sans transition')
  assertStableShell(desktopReverse.shell, 'desktop serif-to-sans transition')
  assertWeightPreservingHandoff(desktopReverse.compositing, 'desktop serif-to-sans transition')
  assertContinuousSettlement(desktopReverse.settlement, 'desktop serif-to-sans transition')
  assert.deepEqual(errors, [])
  await wide.close()
} finally {
  await close()
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  )
}
