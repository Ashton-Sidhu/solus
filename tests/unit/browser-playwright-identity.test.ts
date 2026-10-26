import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { initBrowserRegistry, type BrowserRegistry } from '@solus/server/browser/browser-registry'
import { chromeIdentity, registerPlaywrightBrowserHost } from '@solus/server/browser/playwright-host'
import { setBrowserHeadlessHost, setBrowserProfileHost } from '@solus/server/browser/surface-driver'

/**
 * A headless page on a standalone server presents as plain Chrome.
 *
 * Google, Cloudflare, CNN, and DuckDuckGo refuse a page that says
 * `HeadlessChrome` or sets `navigator.webdriver`, and DuckDuckGo also refuses a
 * page whose user agent and client hints disagree. A person reads these pages,
 * so the identity is part of the feature, not an evasion.
 */

const HEADLESS_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.7339.16 Safari/537.36'

describe('chromeIdentity', () => {
  test('drops Headless and reduces the version, as Chrome does', () => {
    const identity = chromeIdentity(HEADLESS_MAC, { platform: 'darwin', arch: 'arm64', release: '25.0.0' })
    expect(identity?.userAgent).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    )
  })

  test('gives client hints that agree with the user agent', () => {
    const metadata = chromeIdentity(HEADLESS_MAC, { platform: 'darwin', arch: 'arm64', release: '25.0.0' })?.userAgentMetadata
    expect(metadata?.brands.map((brand) => brand.brand)).toContain('Google Chrome')
    expect(metadata?.brands.find((brand) => brand.brand === 'Google Chrome')?.version).toBe('140')
    expect(metadata?.fullVersionList.find((brand) => brand.brand === 'Google Chrome')?.version).toBe('140.0.7339.16')
    expect(JSON.stringify(metadata)).not.toContain('Headless')
    expect(metadata).toMatchObject({ platform: 'macOS', platformVersion: '', architecture: 'arm', bitness: '64', mobile: false })
  })

  test('names the Linux kernel and an x86 architecture', () => {
    const linux = HEADLESS_MAC.replace('Macintosh; Intel Mac OS X 10_15_7', 'X11; Linux x86_64')
    const metadata = chromeIdentity(linux, { platform: 'linux', arch: 'x64', release: '6.8.0' })?.userAgentMetadata
    expect(metadata).toMatchObject({ platform: 'Linux', platformVersion: '6.8.0', architecture: 'x86', bitness: '64' })
  })

  test('leaves a user agent that is not headless alone', () => {
    expect(chromeIdentity(HEADLESS_MAC.replace('HeadlessChrome', 'Chrome'), { platform: 'darwin', arch: 'arm64', release: '' })).toBeNull()
  })
})

async function hasChromium(): Promise<boolean> {
  try {
    const loaded: { chromium?: { launch(options: { headless: boolean }): Promise<{ close(): Promise<void> }> } } =
      await import('playwright-core')
    const probe = await loaded.chromium?.launch({ headless: true }).catch(() => null)
    if (!probe) return false
    await probe.close()
    return true
  } catch {
    return false
  }
}

const chromium = await hasChromium()

describe.skipIf(!chromium)('headless page identity (Playwright Chromium)', () => {
  let registry: BrowserRegistry
  let stopHost: (() => Promise<void>) | null = null
  let browserPageId = ''
  let secChUa: string | null = null
  // localhost is a secure context, so `navigator.userAgentData` exists there.
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      secChUa = request.headers.get('sec-ch-ua')
      return new Response('<!doctype html><p>hi</p>', { headers: { 'content-type': 'text/html' } })
    },
  })

  beforeAll(async () => {
    stopHost = await registerPlaywrightBrowserHost(async () => undefined)
    registry = initBrowserRegistry({ pageChanged() {}, pageClosed() {}, surfaceRequested() {} })
    browserPageId = registry.open({ target: { kind: 'url', url: `http://localhost:${server.port}/` } }, 'local:owner').browserPageId
  })

  afterAll(async () => {
    await registry.close(browserPageId, { force: true }).catch(() => {})
    await stopHost?.()
    setBrowserHeadlessHost(null)
    setBrowserProfileHost(null)
    server.stop(true)
  })

  async function evaluate(expression: string): Promise<unknown> {
    const result = await registry.interact(browserPageId, { kind: 'evaluate', expression })
    return result.value === undefined ? undefined : JSON.parse(result.value)
  }

  test('the page does not announce automation and its hints agree', async () => {
    expect(await evaluate('navigator.webdriver')).toBe(false)
    const userAgent = String(await evaluate('navigator.userAgent'))
    expect(userAgent).not.toContain('Headless')
    expect(userAgent).toMatch(/ Chrome\/\d+\.0\.0\.0 /)
    const brands = await evaluate('navigator.userAgentData.brands.map((brand) => brand.brand)')
    expect(brands).toContain('Google Chrome')
    expect(secChUa).toContain('"Google Chrome"')
    expect(secChUa).not.toContain('Headless')
  })

  test('a device preset user agent wins, and leaving the preset restores Chrome', async () => {
    await registry.setViewport(browserPageId, { mode: 'preset', presetId: 'iphone-se' })
    expect(String(await evaluate('navigator.userAgent'))).toContain('iPhone')
    await registry.setViewport(browserPageId, { mode: 'custom', width: 1280, height: 800 })
    const userAgent = String(await evaluate('navigator.userAgent'))
    expect(userAgent).not.toContain('iPhone')
    expect(userAgent).toMatch(/ Chrome\/\d+\.0\.0\.0 /)
  })
})
