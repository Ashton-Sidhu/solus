import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

/**
 * What the browser pane shows while it is waiting.
 *
 * Three waits exist and all three used to look like nothing happening: a native
 * guest is blank until the host navigates it, a streamed surface is blank until
 * the first frame lands, and a discovery scan showed the "nothing is listening"
 * empty state before the host had answered. These are asserted against the
 * markup because the rules live entirely there.
 */

const componentDir = join(
  import.meta.dir,
  '../../packages/workspace-ui/src/components/browser',
)

const read = (name: string): string =>
  readFileSync(join(componentDir, name), 'utf8')

describe('a browser page with nothing to paint yet', () => {
  test('is skeleton-shaped on the native surface, not one line of text', () => {
    const layer = read('BrowserWebviewLayer.svelte')
    expect(layer).toContain('<BrowserSkeleton')
    // WHY: the veil is the only thing between the user and a white rectangle
    // for the whole first load, so it has to read as the page filling in.
    expect(layer).not.toContain('Loading {entry.page.label}…')
  })

  test('is the same skeleton on a streamed client', () => {
    // WHY: web and mobile cannot host a `<webview>`. If only the desktop path
    // got the skeleton, the clients with the slowest wait would keep the worst
    // treatment of it.
    const streamed = read('StreamedSurface.svelte')
    expect(streamed).toContain('<BrowserSkeleton')
    expect(streamed).not.toContain('Connecting to the browser…')
  })

  test('keeps the last streamed picture visible while the next frame connects', () => {
    // WHY: returning to a streamed page must not replace its useful last frame
    // with a skeleton only because its hidden subscription correctly stopped.
    const streamed = read('StreamedSurface.svelte')
    expect(streamed).toContain('browserStore.cachedFrame(pageKey)')
    expect(streamed).toContain('painter.restore(cachedFrame.data)')
  })

  test('names the page it is waiting for', () => {
    // WHY: a pane can hold several pages, so an anonymous wait says nothing
    // about which one is loading.
    const skeleton = read('BrowserSkeleton.svelte')
    expect(skeleton).toContain('aria-label="Loading {label}"')
  })

  test('is bare bars, like every other skeleton in the app', () => {
    // WHY: the house treatment (FilesPaneSkeleton, DiffLoadingSkeleton) is a
    // stack of bare shimmer bars. Framing them in the border box of the row
    // they stand for gives the placeholder an outline no other loading surface
    // has, so the pane reads as a different app while it waits.
    for (const name of ['BrowserSkeleton.svelte', 'BrowserTargetPicker.svelte']) {
      const rows = read(name)
        .split('\n')
        .filter((line) => line.includes('<Skeleton') || line.includes('aria-hidden'))
      for (const row of rows) expect(row).not.toContain('border')
    }
  })
})

describe('the dev-server picker while the host is still scanning', () => {
  const picker = read('BrowserTargetPicker.svelte')

  test('shows placeholder offers rather than the empty state', () => {
    // WHY: "nothing is listening" during a scan tells the user to go start a
    // server they may already be running. The empty copy must be reachable only
    // after the scan has answered.
    const scanning = picker.indexOf('{:else if loading}')
    const empty = picker.indexOf('Nothing is listening')
    expect(scanning).toBeGreaterThan(-1)
    expect(empty).toBeGreaterThan(scanning)
    expect(picker).toContain('<Skeleton')
  })

  test('says which offer it is opening', () => {
    // WHY: the picker stays mounted for the whole offscreen load, so a chosen
    // offer with no busy state is a click with no answer at all.
    expect(picker).toContain('Opening…')
    expect(picker).toContain('disabled={openingUrl !== null}')
  })
})
