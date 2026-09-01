import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

/**
 * Reaching the browser from a phone.
 *
 * The browser route is placed `aside`, and the mobile shell renders no companion
 * pane — it renders a fixed set of full-screen surfaces. So a route that works
 * everywhere else opens a pane nothing draws, which is why the command used to
 * be hidden on mobile entirely. These rules are asserted against the source
 * because they live in markup and in a command list, and the failure they guard
 * against is silent: a menu entry that appears to do nothing.
 */

function read(path: string): string {
  return readFileSync(join(import.meta.dir, '../..', path), 'utf8')
}

const webLayout = read('apps/client/src/components/WebLayout.svelte')
const app = read('packages/workspace-ui/src/App.svelte')
const plusMenu = read('apps/client/src/components/MobilePlusMenu.svelte')
const streamed = read('packages/workspace-ui/src/components/browser/StreamedSurface.svelte')
const workspace = read('packages/workspace-ui/src/contexts/workspace/workspace.context.svelte.ts')

describe('the mobile browser outlet', () => {
  test('the shared entry point navigates to the registered browser route', () => {
    // WHY: the retired `preview` name is accepted only while decoding old links.
    // Passing it directly to the router has no descriptor and crashes before the
    // Browser pane can open from any client surface.
    expect(workspace).toContain(
      "this.router.navigate({ name: 'browser', params }, { target: 'aside' })",
    )
  })

  test('the mobile shell renders the browser pane as a full-screen surface', () => {
    // WHY: without this branch the route opens a pane the mobile shell never
    // draws, and every entry point into browser silently does nothing.
    expect(webLayout).toContain('router.at("browser")')
    expect(webLayout).toContain('components/browser/BrowserPane.svelte')
  })

  test('it hands the surface the pane the route actually landed in', () => {
    // WHY: the pane exists in the location even on mobile. Inventing an id
    // would give the surface pane controls that act on nothing.
    expect(webLayout).toContain('pane.base?.name === "browser"')
  })

  test('the command palette no longer hides the browser command on a phone', () => {
    // WHY: this gate was the record of the missing outlet. Leaving it after the
    // outlet exists would keep the capability unreachable on the one client the
    // feature was asked for.
    const command = app.slice(app.indexOf('id: "open-browser"'))
    expect(command).not.toBe('')
    const before = app.slice(0, app.indexOf('id: "open-browser"'))
    expect(before.slice(-400)).not.toContain('runtime.isMobileViewport')
  })

  test('the phone has a way in that is not the palette', () => {
    // WHY: mobile has no command palette. A capability reachable only through
    // one is not reachable.
    expect(plusMenu).toContain('session.openBrowser()')
  })

  test('a streamed page can be scrolled by touch', () => {
    // WHY: the canvas takes `touch-none` so the browser will not scroll the
    // pane instead, and a phone has no wheel — so without a touch handler the
    // shown page cannot be scrolled at all on the client that needs it most.
    expect(streamed).toContain('ontouchstart')
    expect(streamed).toContain('ontouchmove')
    expect(streamed).toContain('kind: "scrollAt"')
  })

  test('a tap still reaches the page as a click', () => {
    // WHY: the browser synthesizes a click after a touch that did not move,
    // which is only true while the touch start is not default-prevented.
    const start = streamed.slice(streamed.indexOf('function onTouchStart'))
    const body = start.slice(0, start.indexOf('}\n'))
    expect(body).not.toContain('preventDefault')
  })
})
