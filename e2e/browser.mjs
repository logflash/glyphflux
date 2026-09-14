import { chromium } from 'playwright-core'

export async function getBrowser() {
  const cdp = process.env.FONT_MORPH_E2E_CDP
  if (cdp) {
    const browser = await chromium.connectOverCDP(cdp)
    return { browser, close: () => browser.close() }
  }
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  return { browser, close: () => browser.close() }
}

export async function newPage(browser) {
  const context = browser.contexts()[0] ?? (await browser.newContext())
  return context.newPage()
}
