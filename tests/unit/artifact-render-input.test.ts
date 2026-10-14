import { describe, expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { wrapSandboxDocument } from '../../packages/contracts/src/artifact-sandbox'
import {
  artifactKeyMessageSchema,
  artifactLinkMessageSchema,
  isRenderShortcut,
  renderShortcutChords,
  type RenderChord,
} from '../../packages/workspace-ui/src/components/artifact/lib/render-input'

const chord = (code: string, mods: Partial<Omit<RenderChord, 'code'>> = {}): RenderChord => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
})

describe('a link click in a render', () => {
  test('only a web or mail link may leave the render', () => {
    // WHY: the page is agent-authored. A `javascript:` or `file:` URL handed to
    // the system opener would run or read something on the reader's machine.
    const link = (url: string) => artifactLinkMessageSchema.safeParse({ type: 'solus-artifact-link', url }).success
    expect(link('https://github.com/acme/app/pull/12')).toBe(true)
    expect(link('http://example.com/')).toBe(true)
    expect(link('mailto:a@example.com')).toBe(true)
    expect(link('javascript:alert(1)')).toBe(false)
    expect(link('file:///etc/passwd')).toBe(false)
    expect(link('solus://settings')).toBe(false)
    expect(link('not a url')).toBe(false)
  })
})

describe('the shortcuts a focused render passes on', () => {
  test('a view command passes on, in the reader\'s own bindings', () => {
    const chords = renderShortcutChords({}, true)
    expect(isRenderShortcut(chords, chord('KeyK', { metaKey: true }))).toBe(true)
    // `mod` is Control off a Mac.
    expect(isRenderShortcut(renderShortcutChords({}, false), chord('KeyK', { ctrlKey: true }))).toBe(true)
    // A rebind moves the chord, and the old one stays with the page.
    const rebound = renderShortcutChords({ 'global.command-palette': { mod: true, shift: true, code: 'KeyJ' } }, true)
    expect(isRenderShortcut(rebound, chord('KeyJ', { metaKey: true, shiftKey: true }))).toBe(true)
    expect(isRenderShortcut(rebound, chord('KeyK', { metaKey: true }))).toBe(false)
    // A removed shortcut passes on nothing.
    expect(isRenderShortcut(renderShortcutChords({ 'global.command-palette': null }, true), chord('KeyK', { metaKey: true }))).toBe(false)
  })

  test('a command that changes a session never passes on', () => {
    // WHY: the page can post any key it likes. A forged key must not reach a
    // command that sends, creates, or stops work.
    const chords = renderShortcutChords({}, true)
    expect(isRenderShortcut(chords, chord('KeyN', { metaKey: true }))).toBe(false) // new session
    expect(isRenderShortcut(chords, chord('KeyW', { metaKey: true, shiftKey: true }))).toBe(false) // close tab
    expect(isRenderShortcut(chords, chord('KeyS', { altKey: true, shiftKey: true }))).toBe(false) // screenshot
  })

  test('a chord another command shares stays with the page', () => {
    // WHY: the replayed key goes through the whole dispatcher, so an allowed
    // chord that also fires another command would reach that command too.
    const chords = renderShortcutChords({ 'global.new-session': { mod: true, code: 'KeyK' } }, true)
    expect(isRenderShortcut(chords, chord('KeyK', { metaKey: true }))).toBe(false)
  })

  test('a plain key is typing, so it never passes on', () => {
    const chords = renderShortcutChords({ 'global.command-palette': { code: 'KeyK' } }, true)
    expect(isRenderShortcut(chords, chord('KeyK'))).toBe(false)
  })

  test('a key report must be complete', () => {
    const base = { type: 'solus-artifact-key', code: 'KeyK', key: 'k', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false }
    expect(artifactKeyMessageSchema.safeParse(base).success).toBe(true)
    expect(artifactKeyMessageSchema.safeParse({ ...base, metaKey: 'yes' }).success).toBe(false)
    expect(artifactKeyMessageSchema.safeParse({ ...base, type: 'solus-artifact-link' }).success).toBe(false)
  })
})

type Listener = (event: FakeEvent) => void
interface FakeEvent {
  isTrusted: boolean
  defaultPrevented: boolean
  preventDefault(): void
  composedPath(): object[]
  [field: string]: unknown
}

/** Runs the page's scripts against a fake window that dispatches like the DOM:
 *  capture listeners, then the page's own handler, then the bubble listeners
 *  on the window as they stand at that moment. */
function loadPage(isolated: boolean) {
  const scripts = [...wrapSandboxDocument('', '', isolated).matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  const posted: Array<{ type: string; [field: string]: unknown }> = []
  const parent = { postMessage: (message: { type: string }) => posted.push(message) }
  const listeners: Array<{ type: string; fn: Listener; capture: boolean }> = []
  const window = {
    addEventListener: (type: string, fn: Listener, capture = false) => listeners.push({ type, fn, capture }),
    removeEventListener: (type: string, fn: Listener) => {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn)
      if (i !== -1) listeners.splice(i, 1)
    },
  }
  const document = { readyState: 'loading', addEventListener() {}, baseURI: 'about:srcdoc' }
  for (const script of scripts) {
    runInNewContext(script, { window, parent, document, URL, setTimeout() {} })
  }
  function dispatch(type: string, fields: Record<string, unknown>, page?: (e: FakeEvent) => void) {
    const event: FakeEvent = {
      isTrusted: true,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true },
      composedPath: () => [fields.target ?? {}],
      ...fields,
    }
    for (const l of listeners.filter((l) => l.type === type && l.capture)) l.fn(event)
    page?.(event)
    for (const l of listeners.filter((l) => l.type === type && !l.capture)) l.fn(event)
    return event
  }
  const sendChords = (chords: RenderChord[]) => dispatch('message', { source: parent, data: { type: 'solus-artifact-shortcuts', chords } })
  return { posted, dispatch, sendChords }
}

const anchor = (href: string) => ({ matches: (selector: string) => selector === 'a[href]', getAttribute: () => href })
const key = (fields: Record<string, unknown>) => ({ code: 'KeyK', key: 'k', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, target: { tagName: 'DIV' }, ...fields })

describe('the page forwards what the app owns', () => {
  test('a web link goes to the app instead of navigating the frame', () => {
    const page = loadPage(false)
    const click = page.dispatch('click', { button: 0, target: anchor('https://github.com/acme/app/pull/12') })
    expect(click.defaultPrevented).toBe(true)
    expect(page.posted).toEqual([{ type: 'solus-artifact-link', url: 'https://github.com/acme/app/pull/12' }])
  })

  test('a link the page handles, or one that is not a web link, stays with the page', () => {
    const page = loadPage(false)
    page.dispatch('click', { button: 0, target: anchor('https://example.com/') }, (e) => e.preventDefault())
    page.dispatch('click', { button: 0, target: anchor('#section') })
    page.dispatch('click', { button: 0, target: anchor('javascript:void 0') })
    expect(page.posted).toEqual([])
  })

  test('a review lens forwards no links', () => {
    // WHY: a lens is written from a pull request anyone can influence, and a
    // link out could carry the change it describes.
    const page = loadPage(true)
    page.dispatch('click', { button: 0, target: anchor('https://example.com/?diff=secret') })
    expect(page.posted).toEqual([])
  })

  test('a shortcut chord passes on only when the page leaves it alone', () => {
    const page = loadPage(false)
    page.sendChords([chord('KeyK', { metaKey: true })])
    const forwarded = page.dispatch('keydown', key({}))
    expect(forwarded.defaultPrevented).toBe(true)
    expect(page.posted).toEqual([{ type: 'solus-artifact-key', code: 'KeyK', key: 'k', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false }])

    page.posted.length = 0
    page.dispatch('keydown', key({}), (e) => e.preventDefault()) // the page's own ⌘K
    page.dispatch('keydown', key({ target: { tagName: 'INPUT' } })) // typing in a field
    page.dispatch('keydown', key({ code: 'KeyB' })) // not an app shortcut
    expect(page.posted).toEqual([])
  })

  test('only the parent frame names the chords', () => {
    const page = loadPage(false)
    page.dispatch('message', { source: {}, data: { type: 'solus-artifact-shortcuts', chords: [chord('KeyK', { metaKey: true })] } })
    page.dispatch('keydown', key({}))
    expect(page.posted).toEqual([])
  })
})
