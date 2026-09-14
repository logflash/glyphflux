import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getBrowser } from '../e2e/browser.mjs'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const demoRoot = resolve(packageRoot, 'demo-dist/client')
const pureRenderer = process.env.GLYPHFLUX_AUDIT_PURE === '1'
const compositeOnly = process.env.GLYPHFLUX_AUDIT_COMPOSITE === '1'
const outputRoot = resolve(
  packageRoot,
  pureRenderer
    ? 'test-results/continuity-pure'
    : compositeOnly
      ? 'test-results/continuity-composite'
      : 'test-results/continuity',
)
const catalog = JSON.parse(await readFile(resolve(packageRoot, 'demo/catalog.json'), 'utf8'))
const defaultLocales = catalog.languages.map(({ code }) => code)
const requestedLocales = (process.env.GLYPHFLUX_AUDIT_LOCALES ?? defaultLocales.join(','))
  .split(',')
  .map((locale) => locale.trim())
  .filter(Boolean)
const languages = requestedLocales.map((locale) => {
  const language = catalog.languages.find(({ code }) => code === locale)
  assert(language, `Unknown audit locale ${locale}`)
  return language
})
const progressValues = [0, 0.03, 0.5, 0.9, 0.97, 0.99, 1]
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

await mkdir(outputRoot, { recursive: true })
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
const address = server.address()
assert(address && typeof address !== 'string')

const { browser, close } = await getBrowser()
try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 500 } })
  const page = await context.newPage()
  const captures = []
  for (const language of languages) {
    await page.goto(`http://127.0.0.1:${address.port}/${language.code}`, {
      waitUntil: 'networkidle',
    })
    await page.waitForSelector('[data-demo-status="ready"]')
    await page.evaluate(() => document.fonts.ready)
    if (pureRenderer) {
      await page.addStyleTag({
        content: `
          [data-demo-endpoint], [data-demo-exact-endpoint] { opacity: 0 !important; }
          [data-font-morph-sdf] { opacity: 1 !important; }
        `,
      })
    } else if (compositeOnly) {
      await page.addStyleTag({
        content: '[data-demo-endpoint] { opacity: 0 !important; }',
      })
    }
    for (const progress of progressValues) {
      const value = Math.round(progress * 1_000)
      await page.locator('#progress').evaluate((element, next) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter?.call(element, String(next))
        element.dispatchEvent(new Event('input', { bubbles: true }))
      }, value)
      await page.waitForFunction(
        ([locale, expected]) =>
          document
            .querySelector('[data-font-morph-sdf]')
            ?.getAttribute('data-font-morph-sdf-frame')
            ?.startsWith(`${locale}:${expected}:`),
        [language.code, progress],
      )
      await page.evaluate(
        () => new Promise((resolveFrame) => requestAnimationFrame(() => resolveFrame())),
      )
      const image = await page.locator('.stage').screenshot({ type: 'png' })
      await writeFile(
        resolve(outputRoot, `${language.code}-${String(value).padStart(4, '0')}.png`),
        image,
      )
      captures.push({
        language,
        progress,
        image,
      })
    }
  }

  for (let pageIndex = 0; pageIndex < Math.ceil(languages.length / 4); pageIndex += 1) {
    const selected = languages.slice(pageIndex * 4, pageIndex * 4 + 4)
    const contactSheet = await context.newPage()
    const rows = selected
      .map((language) => {
        const frames = captures.filter((capture) => capture.language.code === language.code)
        return `<section><h2>${language.label} · ${language.text}</h2><div class="frames">${frames
          .map(
            ({ progress, image }) =>
              `<figure><figcaption>${Math.round(progress * 100)}%</figcaption><img src="data:image/png;base64,${image.toString('base64')}"></figure>`,
          )
          .join('')}</div></section>`
      })
      .join('')
    await contactSheet.setContent(`<!doctype html><style>
      * { box-sizing: border-box; }
      body { width: 2100px; margin: 0; padding: 24px; background: white; color: #171717; font: 14px system-ui; }
      section + section { margin-top: 22px; }
      h2 { margin: 0 0 8px; font-size: 18px; }
      .frames { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
      figure { margin: 0; min-width: 0; }
      figcaption { margin-bottom: 3px; color: #555; font: 12px ui-monospace, monospace; }
      img { display: block; width: 100%; height: auto; border: 1px solid #ddd; }
    </style>${rows}`)
    await contactSheet.waitForFunction(() => [...document.images].every((image) => image.complete))
    await contactSheet.screenshot({
      path: resolve(outputRoot, `audit-${pageIndex + 1}.png`),
      fullPage: true,
    })
    await contactSheet.close()
  }
  await context.close()
} finally {
  await close()
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  )
}

console.log(`Wrote ${languages.length} language audits to ${outputRoot}`)
