import { describe, expect, test } from 'bun:test'
import { AppCallFailure, answerAppCall, appResultMessage } from '@solus/client-core/app-calls'
import { desktopPermissionDenied } from '@solus/contracts/app-desktop'
import { wrapSandboxDocument } from '@solus/contracts/artifact-sandbox'

// The way of a desktop call from an app's page to its app window and back
// (docs/plans/app-desktop-capabilities.md §3). The frame's bridge script runs
// here against a fake window, so the page sees what an author programs
// against: `solusApp.desktop`, a failure with its code as `name`, and a
// notification's route in `location.hash`.

const host = async () => JSON.stringify({ value: 'host' })

describe('a desktop call in the client', () => {
  test('only a desktop app window answers it', async () => {
    const outside = answerAppCall(host, '@desktop/badge', { count: 1 }, { save: async () => {} })
    await expect(outside).rejects.toMatchObject({ failure: { code: 'DesktopUnavailable' } })

    const calls: string[] = []
    const inWindow = await answerAppCall(host, '@desktop/badge', { count: 1 }, {
      save: async () => {},
      desktop: async (operation) => { calls.push(operation); return null },
    })
    expect(inWindow).toBeNull()
    expect(calls).toEqual(['badge'])
  })

  test('a typed failure reaches the page with its code', async () => {
    const message = await appResultMessage(4, Promise.reject(new AppCallFailure(desktopPermissionDenied('camera'))))
    expect(message).toMatchObject({ ok: false, id: 4, failure: { code: 'DesktopPermissionDenied', permission: 'camera' } })
    const plain = await appResultMessage(5, Promise.reject(new Error('no')))
    expect(plain).toEqual({ type: 'solus-app-result', id: 5, ok: false, error: 'no' })
  })
})

interface FakeFrame {
  solusApp?: { desktop: boolean; call(name: string, args: object): Promise<unknown>; on(listener: (event: string, detail: unknown) => void): () => void }
  location: { hash: string }
  receive(data: object): void
  posted: { type: string; id: number; name: string }[]
}

/** Runs the bridge of an app frame against a fake window whose parent is the client. */
function frame(isDesktop: boolean): FakeFrame {
  const html = wrapSandboxDocument('<p>app</p>', '', false, { network: [], desktop: isDesktop })
  const start = html.indexOf('<script>(function(){\n  if (window.solusApp) return;')
  const script = html.slice(start + '<script>'.length, html.indexOf('</script>', start))
  const listeners: ((event: { data: object; source: object }) => void)[] = []
  const posted: FakeFrame['posted'] = []
  const parent = { postMessage: (message: FakeFrame['posted'][number]) => { posted.push(message) } }
  const fake: FakeFrame & { addEventListener(type: string, listener: (event: { data: object; source: object }) => void): void } = {
    location: { hash: '' },
    posted,
    addEventListener: (_type, listener) => { listeners.push(listener) },
    receive: (data) => { for (const listener of listeners) listener({ data, source: parent }) },
  }
  new Function('window', 'parent', 'location', script)(fake, parent, fake.location)
  return fake
}

describe('the bridge of an app frame', () => {
  test('says whether the page is in a desktop app window', () => {
    expect(frame(true).solusApp?.desktop).toBe(true)
    expect(frame(false).solusApp?.desktop).toBe(false)
  })

  test('rejects a failed desktop call with an Error named for its code', async () => {
    const page = frame(true)
    const call = page.solusApp!.call('@desktop/shortcut-register', { accelerator: 'Alt+K' })
    page.receive({ type: 'solus-app-result', id: page.posted[0].id, ok: false, error: 'Alt+K is in use.', failure: { code: 'ShortcutTaken', accelerator: 'Alt+K', message: 'Alt+K is in use.' } })
    const error = await call.catch((reason: Error & { failure?: object }) => reason)
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ name: 'ShortcutTaken', message: 'Alt+K is in use.', failure: { accelerator: 'Alt+K' } })
  })

  test('opens a notification\'s route, and gives each event its detail', () => {
    const page = frame(true)
    const seen: [string, unknown][] = []
    page.solusApp!.on((event, detail) => seen.push([event, detail]))
    page.receive({ type: 'solus-app-event', event: 'open-route', detail: { route: '#/reports/42' } })
    page.receive({ type: 'solus-app-event', event: 'open-route', detail: { route: 'https://example.com' } })
    page.receive({ type: 'solus-app-event', event: 'desktop-shortcut', detail: { id: 'a' } })
    expect(page.location.hash).toBe('#/reports/42')
    expect(seen.at(-1)).toEqual(['desktop-shortcut', { id: 'a' }])
  })
})
