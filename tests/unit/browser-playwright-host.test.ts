import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

/**
 * The standalone server's headless host.
 *
 * The desktop app hosts a browser page in a Chromium it already has. A server
 * outside Electron has none, so until this host exists every drive verb there
 * fails: an agent working against a remote Solus cannot look at anything.
 *
 * Two rules keep it from becoming a second, divergent product, and one keeps it
 * from becoming a boot dependency. All three are shapes in the module rather
 * than values it returns — launching a real browser is not a unit test — so they
 * are asserted against the source, as the CDP timeout rules are.
 */

const root = join(import.meta.dir, '../../packages/server/src/browser')
const source = readFileSync(join(root, 'playwright-host.ts'), 'utf8')
const desktop = readFileSync(
  join(import.meta.dir, '../../apps/desktop/src/main/browser/chromium-driver.ts'),
  'utf8',
)

describe('playwright browser host', () => {
  test('an absent browser is a state, not a boot failure', () => {
    // The package is optional. A server installed without it must keep working
    // exactly as it did — no browser host, verbs that say so — rather than
    // failing to start.
    expect(source).toContain('async function loadChromium')
    expect(source).toMatch(/catch \{\s*return null/)
    expect(source).toContain('browser_playwright_absent')
    // A literal specifier would let a bundler follow the optional dependency and
    // turn its absence into a build error.
    expect(source).not.toMatch(/import\(['"]playwright-core['"]\)/)
  })

  test('it emulates the page before it navigates', () => {
    // The same ordering the desktop headless host follows: the page lays out
    // once at the size that was asked for, and the console and network rings
    // cover its own load instead of starting mid-life.
    expect(source.indexOf('applyEmulation(request.emulation)')).toBeLessThan(
      source.indexOf('page.goto(request.url)'),
    )
    expect(source.indexOf('enableDomains()')).toBeLessThan(source.indexOf('page.goto(request.url)'))
  })

  test('it drives the guest with the same commands the desktop driver does', () => {
    // A page hosted here and a page hosted in a pane must not be two different
    // products. Playwright supplies the process; it does not get to be a second
    // implementation of emulation, capture, or input.
    for (const command of [
      'Emulation.setDeviceMetricsOverride',
      'Emulation.setTouchEmulationEnabled',
      'Emulation.setEmulatedMedia',
      'Page.captureScreenshot',
      'Page.startScreencast',
      'Page.screencastFrameAck',
      'Input.dispatchMouseEvent',
      'Input.insertText',
    ]) {
      expect(source).toContain(command)
      expect(desktop).toContain(command)
    }
  })

  test('turning touch off sends no touch-point count', () => {
    // Chromium validates `maxTouchPoints` against 1..16 before it reads
    // `enabled`, so a 0 rejects the whole emulation call.
    expect(source).toContain("{ enabled: false }")
  })

  test('no CDP command can hang the caller', () => {
    // A stalled command under an agent's tool call is a turn that simply stops:
    // no error, no event, nothing to react to.
    for (const call of source.matchAll(/this\.cdp\.send\(/g)) {
      const line = source.slice(source.lastIndexOf('\n', call.index) + 1, source.indexOf('\n', call.index))
      expect(line).toContain('withTimeout(')
    }
  })

  test('closing a page keeps the project profile', () => {
    // The profile is the project's login and outlives any one page; closing the
    // context with the page would sign every other page out.
    const dispose = source.slice(source.indexOf('async dispose()'), source.indexOf('private async send('))
    expect(dispose).toContain('this.page.close()')
    expect(dispose).not.toContain('context.close()')
  })
})
