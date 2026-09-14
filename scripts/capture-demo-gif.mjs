import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { basename, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import gifenc from 'gifenc'
import pngjs from 'pngjs'
import { getBrowser } from '../e2e/browser.mjs'

const { GIFEncoder, applyPalette, quantize } = gifenc
const { PNG } = pngjs
const demoRoot = fileURLToPath(new URL('../demo-dist/client/', import.meta.url))
const outputPath = fileURLToPath(new URL('../assets/demo.gif', import.meta.url))
const packageMetadata = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
)
const frameDelay = 70
const paletteFormat = 'rgb444'
const controlledLocales = ['en', 'zh-CN', 'ar']
const viewLocales = ['el', 'hi', 'ko']
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
}

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1)
    let file = resolve(demoRoot, relative)
    if (!file.startsWith(demoRoot)) {
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

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
const address = server.address()
assert(address && typeof address !== 'string')

const frames = []
const viewport = { width: 800, height: 480 }
const { browser, close } = await getBrowser()

try {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })

  await page.goto(`http://127.0.0.1:${address.port}/en`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-demo-status="ready"]')
  await page.evaluate(() => document.fonts.ready)
  await page.addStyleTag({
    content: `
      body { overflow: hidden; }
      .demo { min-height: 480px; padding: 20px 36px; }
      .demo-header { padding-bottom: 18px; }
      .stage { height: 230px; }
      .progress-control { padding-top: 16px; }
      .status { margin-top: 7px; }
      .view-demo { min-height: 480px; padding: 20px 36px; }
      .view-demo-scene { min-height: 0; padding-top: 18px; }
      .view-demo-copy { margin-top: 14px; }
      .view-demo-action { margin-top: 14px; }
      #capture-pointer {
        position: fixed;
        z-index: 2147483647;
        width: 16px;
        height: 16px;
        border: 2px solid white;
        border-radius: 50%;
        background: #171717;
        box-shadow: 0 1px 5px rgb(0 0 0 / 35%);
        pointer-events: none;
        transform: translate(-50%, -50%);
      }
      #capture-curtain {
        position: fixed;
        z-index: 2147483647;
        inset: 0;
        background: #fff;
        opacity: 0;
        pointer-events: none;
      }
    `,
  })
  await page.evaluate(
    ({ packageName }) => {
      const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const pattern = new RegExp(escaped, 'gi')
      const scrub = () => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
          acceptNode: (node) =>
            node.parentElement?.matches('script, style')
              ? NodeFilter.FILTER_REJECT
              : NodeFilter.FILTER_ACCEPT,
        })
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.nodeValue && pattern.test(node.nodeValue)) {
            node.nodeValue = node.nodeValue.replace(pattern, 'The library')
          }
          pattern.lastIndex = 0
        }
        const eyebrow = document.querySelector('.eyebrow')
        if (eyebrow && eyebrow.textContent !== 'Same text · different fonts') {
          eyebrow.textContent = 'Same text · different fonts'
        }
      }
      window.__neutralizeDemoBrand = scrub
      scrub()
      new MutationObserver(scrub).observe(document.body, {
        childList: true,
        characterData: true,
        subtree: true,
      })
      const pointer = document.createElement('span')
      pointer.id = 'capture-pointer'
      pointer.setAttribute('aria-hidden', 'true')
      document.body.append(pointer)
      const curtain = document.createElement('span')
      curtain.id = 'capture-curtain'
      curtain.setAttribute('aria-hidden', 'true')
      document.body.append(curtain)
    },
    { packageName: packageMetadata.name },
  )

  const pointer = { x: 0, y: 0 }
  const setPointer = async (x, y) => {
    pointer.x = x
    pointer.y = y
    await page.locator('#capture-pointer').evaluate(
      (element, point) => {
        element.style.left = `${point.x}px`
        element.style.top = `${point.y}px`
      },
      { x, y },
    )
  }
  const capture = async (delay = frameDelay) => {
    await page.evaluate(() => window.__neutralizeDemoBrand?.())
    const brandingVisible = await page.evaluate(
      (packageName) =>
        document.body.innerText.toLowerCase().includes(packageName.toLowerCase()),
      packageMetadata.name,
    )
    assert.equal(brandingVisible, false, 'capture frames must remain package-name neutral')
    const controlledLayout = await page.evaluate(() => {
      const source = document.querySelector('.source-caption')?.getBoundingClientRect()
      const target = document.querySelector('.target-caption')?.getBoundingClientRect()
      return source && target ? { source: source.left, target: target.right } : null
    })
    if (controlledLayout) {
      assert(controlledLayout.source < viewport.width / 4, 'source caption must stay left-aligned')
      assert(
        controlledLayout.target > (viewport.width * 3) / 4,
        'target caption must stay right-aligned',
      )
    }
    frames.push({
      png: await page.screenshot({ type: 'png', clip: { x: 0, y: 0, ...viewport } }),
      delay,
    })
  }
  const fadeCurtain = async (targetOpacity, steps = 5) => {
    const curtain = page.locator('#capture-curtain')
    const sourceOpacity = Number(await curtain.evaluate((element) => getComputedStyle(element).opacity))
    for (let step = 1; step <= steps; step += 1) {
      const opacity = sourceOpacity + (targetOpacity - sourceOpacity) * (step / steps)
      await curtain.evaluate((element, value) => {
        element.style.opacity = String(value)
      }, opacity)
      await capture(55)
    }
  }
  const movePointer = async (target, steps = 4) => {
    const source = { ...pointer }
    for (let step = 1; step <= steps; step += 1) {
      const progress = step / steps
      await setPointer(
        source.x + (target.x - source.x) * progress,
        source.y + (target.y - source.y) * progress,
      )
      await capture(55)
    }
  }
  const centerOf = async (locator) => {
    const box = await locator.boundingBox()
    assert(box)
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }
  const sliderPoint = async (progress) => {
    const box = await page.locator('#progress').boundingBox()
    assert(box)
    const inset = 8
    return {
      x: box.x + inset + progress * (box.width - inset * 2),
      y: box.y + box.height / 2,
    }
  }
  const setProgress = async (progress) => {
    const value = Math.round(progress * 1_000)
    const normalized = value / 1_000
    const locale = await page.locator('#locale').inputValue()
    const previous = await page
      .locator('[data-font-morph-sdf]')
      .getAttribute('data-font-morph-sdf-frame')
    const current = Number(await page.locator('#progress').inputValue())
    if (current !== value) {
      await page.locator('#progress').evaluate((element, next) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter?.call(element, String(next))
        element.dispatchEvent(new Event('input', { bubbles: true }))
      }, value)
    }
    await page.waitForFunction(
      ([expectedLocale, expectedProgress, prior, changed]) => {
        const marker = document
          .querySelector('[data-font-morph-sdf]')
          ?.getAttribute('data-font-morph-sdf-frame')
        return (
          marker?.startsWith(`${expectedLocale}:${expectedProgress}:`) &&
          (!changed || marker !== prior)
        )
      },
      [locale, normalized, previous, current !== value],
    )
    await setPointer(...Object.values(await sliderPoint(normalized)))
  }
  const sweep = async (from, to, steps = 12) => {
    for (let step = 1; step <= steps; step += 1) {
      await setProgress(from + (to - from) * (step / steps))
      await capture(step === steps ? 320 : frameDelay)
    }
  }
  const selectLocale = async (locale) => {
    const select = page.locator('#locale')
    await movePointer(await centerOf(select))
    await select.selectOption(locale)
    await select.blur()
    await page.waitForFunction(
      (expected) =>
        document.querySelector('[data-demo-status]')?.getAttribute('data-locale') === expected &&
        document
          .querySelector('[data-font-morph-sdf]')
          ?.getAttribute('data-font-morph-sdf-frame')
          ?.startsWith(`${expected}:0:`),
      locale,
    )
    await capture(260)
  }
  const captureRouteTransition = async (locale, destination) => {
    const button = page.locator('.view-demo-action button')
    await movePointer(await centerOf(button))
    await capture(220)
    await button.click()
    await page.waitForURL(`**/${locale}/view/${destination}`)
    await page.waitForSelector('[data-font-morph-renderer="sdf"]', { state: 'attached' })
    for (let frame = 0; frame < 11; frame += 1) {
      await page.waitForTimeout(42)
      await capture(65)
    }
    await page.waitForFunction(() => !document.querySelector('[data-font-morph-renderer]'))
    await capture(420)
  }
  const selectViewLocale = async (locale) => {
    await fadeCurtain(1)
    await page.locator('#view-locale').selectOption(locale)
    await page.waitForURL(`**/${locale}/view/sans`)
    await page.waitForFunction(
      (expected) =>
        document.querySelector('[data-view-demo]')?.getAttribute('data-view-demo') === 'sans' &&
        document.querySelector('#view-locale')?.value === expected,
      locale,
    )
    await fadeCurtain(0)
    await capture(320)
  }

  await setProgress(0)
  await capture(420)
  await sweep(0, 1)
  await sweep(1, 0)
  for (const locale of controlledLocales.slice(1)) {
    await selectLocale(locale)
    await sweep(0, 1, 10)
  }
  await selectLocale('en')
  const routeLink = page.getByRole('link', { name: 'See the view transition demo' })
  await movePointer(await centerOf(routeLink))
  await fadeCurtain(1)
  await routeLink.click()
  await page.waitForURL('**/en/view/sans')
  await fadeCurtain(0)
  await capture(420)
  let activeViewLocale = 'en'
  for (const locale of viewLocales) {
    if (locale !== activeViewLocale) {
      await selectViewLocale(locale)
      activeViewLocale = locale
    }
    await captureRouteTransition(locale, 'serif')
    await captureRouteTransition(locale, 'sans')
  }

  assert.deepEqual(errors, [])
  assert(frames.length > 0)

  const encoder = GIFEncoder()
  let width
  let height
  const paletteSampleStride = 16
  for (const frame of frames) {
    const image = PNG.sync.read(frame.png)
    width ??= image.width
    height ??= image.height
    assert.equal(image.width, width)
    assert.equal(image.height, height)
  }
  const sampledPixelCount = frames.length * Math.ceil((width * height) / paletteSampleStride)
  const palettePixels = new Uint8Array(sampledPixelCount * 4)
  let paletteOffset = 0
  for (const frame of frames) {
    const image = PNG.sync.read(frame.png)
    for (let pixel = 0; pixel < width * height; pixel += paletteSampleStride) {
      const source = pixel * 4
      palettePixels.set(image.data.subarray(source, source + 4), paletteOffset)
      paletteOffset += 4
    }
  }
  const palette = quantize(palettePixels.subarray(0, paletteOffset), 128, {
    format: paletteFormat,
  })
  let firstFrame = true
  for (const frame of frames) {
    const image = PNG.sync.read(frame.png)
    const indexed = applyPalette(image.data, palette, paletteFormat)
    encoder.writeFrame(indexed, width, height, {
      ...(firstFrame ? { palette } : {}),
      delay: frame.delay,
      dispose: 1,
      repeat: 0,
    })
    firstFrame = false
  }
  encoder.finish()
  const output = encoder.bytes()
  assert(output.byteLength < 10 * 1024 * 1024, `README GIF is too large (${output.byteLength} bytes)`)
  assert.equal(
    basename(outputPath).toLowerCase().includes(packageMetadata.name.toLowerCase()),
    false,
    'the GIF filename must not hard-code the package name',
  )
  await mkdir(new URL('../assets/', import.meta.url), { recursive: true })
  await writeFile(outputPath, output)
  console.log(
    `wrote ${frames.length} frames (${width}×${height}, ${(output.byteLength / 1024 / 1024).toFixed(2)} MiB) to ${outputPath}`,
  )
  await context.close()
} finally {
  await close()
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  )
}
