import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { getBrowser } from '../e2e/browser.mjs'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const outputRoot = resolve(packageRoot, 'demo-dist/client')
const catalog = JSON.parse(await readFile(resolve(packageRoot, 'demo/catalog.json'), 'utf8'))
const defaultLocales = ['en', 'hy', 'bn', 'zh-CN', 'fi', 'el', 'hi', 'ko', 'te', 'yo']
const representativeLocales = (process.env.GLYPHFLUX_HANDOFF_LOCALES ?? defaultLocales.join(','))
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

function inkMetrics(buffer) {
  const image = PNG.sync.read(buffer)
  let left = image.width
  let top = image.height
  let right = -1
  let bottom = -1
  let mass = 0
  let momentX = 0
  let momentY = 0
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const index = (y * image.width + x) * 4
      const darkness = 255 - Math.max(image.data[index], image.data[index + 1], image.data[index + 2])
      if (darkness < 24) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
      mass += darkness
      momentX += x * darkness
      momentY += y * darkness
    }
  }
  assert(right >= left && bottom >= top && mass > 0, 'captured endpoint must contain visible ink')
  return {
    left,
    top,
    right,
    bottom,
    centerX: momentX / mass,
    centerY: momentY / mass,
    mass,
  }
}

function assertEndpointMatch(label, generated, exact) {
  for (const edge of ['left', 'top', 'right', 'bottom']) {
    assert(
      Math.abs(generated[edge] - exact[edge]) <= 2,
      `${label}: generated ${edge} ${generated[edge]} does not settle on exact ${exact[edge]}`,
    )
  }
  assert(
    Math.abs(generated.centerX - exact.centerX) <= 2,
    `${label}: horizontal ink center jumps at handoff (${generated.centerX.toFixed(3)} -> ${exact.centerX.toFixed(3)})`,
  )
  assert(
    Math.abs(generated.centerY - exact.centerY) <= 2,
    `${label}: vertical ink center jumps at handoff (${generated.centerY.toFixed(3)} -> ${exact.centerY.toFixed(3)})`,
  )
  const massRatio = generated.mass / exact.mass
  assert(
    massRatio >= 0.85 && massRatio <= 1.15,
    `${label}: apparent weight jumps at handoff (${massRatio.toFixed(3)})`,
  )
}

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
    for (const locale of representativeLocales) {
      const language = catalog.languages.find(({ code }) => code === locale)
      assert(language)
      for (const sourceRole of ['sans', 'serif']) {
        const targetRole = sourceRole === 'sans' ? 'serif' : 'sans'
        const page = await context.newPage()
        await page.goto(
          `http://127.0.0.1:${address.port}/${locale}/view/${sourceRole}`,
          { waitUntil: 'networkidle' },
        )
        await page.evaluate(() => document.fonts.ready)
        await page.evaluate(() => {
          const nativeRemove = Element.prototype.remove
          Element.prototype.remove = function preserveFinalLayers() {
            if (
              this.classList.contains('font-morph-target-layer') ||
              this.classList.contains('font-morph-blend-root') ||
              this.getAttribute('data-font-morph-renderer') === 'sdf'
            ) {
              this.setAttribute('data-endpoint-audit-preserved', '')
              return
            }
            return nativeRemove.call(this)
          }
        })
        await page.locator('.view-demo-action button').click()
        await page.waitForURL(`**/${locale}/view/${targetRole}`)
        await page.waitForFunction(
          () =>
            document.querySelector('.font-morph-target-layer[data-endpoint-audit-preserved]') &&
            document.querySelector('canvas[data-font-morph-renderer="sdf"]'),
        )
        const clip = await page.locator('.view-heading-position').boundingBox()
        assert(clip)
        const generated = await page
          .evaluate(async () => {
            const heading = document.querySelector('.view-heading')
            const exact = document.querySelector('.font-morph-target-layer')
            const canvas = document.querySelector('canvas[data-font-morph-renderer="sdf"]')
            heading.style.visibility = 'hidden'
            exact.style.visibility = 'hidden'
            canvas.style.setProperty('opacity', '1', 'important')
            await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame))
          })
          .then(() => page.screenshot({ type: 'png', clip }))
        const exact = await page
          .evaluate(async () => {
            const exact = document.querySelector('.font-morph-target-layer')
            const canvas = document.querySelector('canvas[data-font-morph-renderer="sdf"]')
            canvas.style.visibility = 'hidden'
            exact.style.removeProperty('visibility')
            await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame))
          })
          .then(() => page.screenshot({ type: 'png', clip }))
        assertEndpointMatch(
          `${viewport.name}:${locale}:${sourceRole}->${targetRole}`,
          inkMetrics(generated),
          inkMetrics(exact),
        )
        await page.close()
      }
      console.log(`${viewport.name}:${locale}: endpoint handoffs verified`)
    }
    await context.close()
  }
} finally {
  await close()
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  )
}

console.log('Glyphflux endpoint handoffs converge on exact rendered text')
