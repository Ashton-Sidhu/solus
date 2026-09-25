import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { PrMergeResult, IpcContext } from '@solus/contracts/types'
import { asHostApi } from '@solus/client-core/host-api'
import { pullRequestFixture } from './__fixtures__/pull-request'

const toastErrors: string[] = []
mock.module('@solus/workspace-ui/lib/toasts', () => ({
  toasts: {
    error: (title: string) => {
      toastErrors.push(title)
    },
    info: () => {},
    success: () => {},
    warning: () => {},
  },
}))

const previousState = (globalThis as unknown as { $state?: unknown }).$state
const previousHTMLElement = (globalThis as unknown as { HTMLElement?: unknown }).HTMLElement

function installStateRune(): void {
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
    <T>(value: T) => value,
    { snapshot: <T>(value: T) => value },
  )
}

afterEach(() => {
  toastErrors.length = 0
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
  if (previousHTMLElement === undefined) delete (globalThis as unknown as { HTMLElement?: unknown }).HTMLElement
  else (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = previousHTMLElement
})

const ctx = {
  session: { projectPath: '/repos/a', workingDirectory: '/repos/a' },
  window: {},
  settings: {},
  statusBar: {},
} as IpcContext

const NO_CHECKS = {
  prChecks: async () => ({ repo: { host: 'github.com', owner: 'acme', repo: 'a' }, checks: [] }),
  prGuideMetadata: async () => null,
}

async function kindsFor(overrides: Parameters<typeof pullRequestFixture>[1]) {
  const { prRowActions } = await import('@solus/workspace-ui/components/prs/lib/pr-row-actions')
  return prRowActions(pullRequestFixture(7, overrides)).map((action) => action.kind)
}

describe('what a pull request row offers', () => {
  // WHY: Shift on the row, the context menu, and Shift+letter all read this one
  // list. A row must never offer a move the pull request's state or the
  // viewer's permissions rule out — the host would refuse it after the row
  // already showed it.
  test('an open pull request merges or closes; a draft becomes ready instead of merging', async () => {
    expect(await kindsFor({})).toEqual(['merge', 'close'])
    expect(await kindsFor({ draft: true })).toEqual(['ready', 'close'])
  })

  test('a closed pull request reopens and a merged one offers nothing', async () => {
    expect(await kindsFor({ state: 'closed' })).toEqual(['reopen'])
    expect(await kindsFor({ state: 'merged' })).toEqual([])
  })

  test('a viewer without write access, or a repository with no merge method, gets no merge', async () => {
    const readOnly = pullRequestFixture(7).viewerPermissions
    expect(await kindsFor({ viewerPermissions: { ...readOnly, actions: ['close', 'reopen', 'ready', 'draft'] } }))
      .toEqual(['close'])
    const capabilities = pullRequestFixture(7).capabilities
    expect(await kindsFor({ capabilities: { ...capabilities, mergeMethods: [] } })).toEqual(['close'])
  })

  test('Shift and a letter pick an offered action; any other modifier belongs to a global shortcut', async () => {
    const { prRowActionForKey, prRowActions } = await import('@solus/workspace-ui/components/prs/lib/pr-row-actions')
    const open = prRowActions(pullRequestFixture(7))
    const keys = { shiftKey: true, altKey: false, metaKey: false, ctrlKey: false }
    expect(prRowActionForKey({ ...keys, key: 'M' }, open)).toBe('merge')
    expect(prRowActionForKey({ ...keys, key: 'C' }, open)).toBe('close')
    // Ready is not on offer for a pull request that is not a draft.
    expect(prRowActionForKey({ ...keys, key: 'R' }, open)).toBeNull()
    expect(prRowActionForKey({ ...keys, shiftKey: false, key: 'm' }, open)).toBeNull()
    expect(prRowActionForKey({ ...keys, altKey: true, key: 'M' }, open)).toBeNull()
  })

  test('the merge confirmation names the method the row will merge with', async () => {
    const { prMergeConfirmation } = await import('@solus/workspace-ui/components/prs/lib/pr-row-actions')
    const capabilities = pullRequestFixture(7).capabilities
    const confirmation = prMergeConfirmation(pullRequestFixture(7, { capabilities: { ...capabilities, mergeMethods: ['squash'] } }))
    expect(confirmation.title).toBe('Merge #7?')
    expect(confirmation.confirmLabel).toBe('Squash and merge')
  })
})

describe('running a row action', () => {
  test('a refused merge is shown at once, taken back, and reported', async () => {
    installStateRune()
    let answer: (result: PrMergeResult) => void = () => {}
    const api = asHostApi({
      prMerge: () => new Promise<PrMergeResult>((resolve) => { answer = resolve }),
      ...NO_CHECKS,
    })
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const { runPrRowAction } = await import('@solus/workspace-ui/components/prs/lib/pr-row-actions')
    const project = new PrsStore().get(api, 'host-a', ctx)
    project.absorb(pullRequestFixture(7))

    const running = runPrRowAction(project.get(7), 'merge')
    expect(project.prFor(7)?.state).toBe('merged')
    answer({ merged: false, message: 'Required checks have not passed' })
    await running

    expect(project.prFor(7)?.state).toBe('open')
    expect(toastErrors).toEqual(["Couldn't merge the pull request"])
  })
})

describe('Shift held on the pull request page', () => {
  class FakeElement {
    isContentEditable = false
    constructor(readonly tagName: string) {}
  }

  function keyboard() {
    const target = new EventTarget()
    const press = (type: 'keydown' | 'keyup', init: KeyboardEventInit & { key: string }, on: FakeElement = new FakeElement('DIV')) => {
      const event = Object.assign(new Event(type), {
        key: init.key,
        shiftKey: !!init.shiftKey,
        altKey: !!init.altKey,
        metaKey: !!init.metaKey,
        ctrlKey: !!init.ctrlKey,
      })
      Object.defineProperty(event, 'target', { value: on })
      target.dispatchEvent(event)
    }
    return { target: target as unknown as Window, press, blur: () => target.dispatchEvent(new Event('blur')) }
  }

  async function shiftHeld() {
    installStateRune()
    ;(globalThis as unknown as { HTMLElement: unknown }).HTMLElement = FakeElement
    const { ShiftHeld } = await import('@solus/workspace-ui/components/prs/lib/shift-held.svelte')
    return new ShiftHeld()
  }

  test('shows while Shift is down and hides on its keyup', async () => {
    const held = await shiftHeld()
    const keys = keyboard()
    held.listen(keys.target)

    keys.press('keydown', { key: 'Shift', shiftKey: true })
    expect(held.isHeld).toBe(true)
    // Shift+M runs a row action; the actions stay up while Shift stays down.
    keys.press('keydown', { key: 'M', shiftKey: true })
    expect(held.isHeld).toBe(true)
    keys.press('keyup', { key: 'Shift' })
    expect(held.isHeld).toBe(false)
  })

  test('a Shift let go in another window does not leave the actions up', async () => {
    const held = await shiftHeld()
    const keys = keyboard()
    held.listen(keys.target)

    keys.press('keydown', { key: 'Shift', shiftKey: true })
    keys.blur()
    expect(held.isHeld).toBe(false)
  })

  test('Shift while typing, or as part of a global shortcut, is not a request for row actions', async () => {
    const held = await shiftHeld()
    const keys = keyboard()
    held.listen(keys.target)

    keys.press('keydown', { key: 'Shift', shiftKey: true }, new FakeElement('INPUT'))
    expect(held.isHeld).toBe(false)
    keys.press('keydown', { key: 'Shift', shiftKey: true, altKey: true })
    expect(held.isHeld).toBe(false)
  })

  test('leaving the page releases Shift and stops listening', async () => {
    const held = await shiftHeld()
    const keys = keyboard()
    const stop = held.listen(keys.target)

    keys.press('keydown', { key: 'Shift', shiftKey: true })
    stop()
    expect(held.isHeld).toBe(false)
    keys.press('keydown', { key: 'Shift', shiftKey: true })
    expect(held.isHeld).toBe(false)
  })
})

describe('a touch long-press on a row', () => {
  // WHY: a phone has no Shift and no right-click everywhere, so the long-press
  // is its way to the row's actions. The finger lifting must not also open the
  // pull request, and a mouse press must not start one.
  test('opens the menu once held, and the click that ends it is consumed', async () => {
    const { TouchLongPress } = await import('@solus/workspace-ui/components/prs/lib/touch-long-press')
    let opened = 0
    const press = new TouchLongPress(() => { opened += 1 }, 0)

    press.start({ pointerType: 'touch' } as PointerEvent)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(opened).toBe(1)
    expect(press.consumeClick()).toBe(true)
    expect(press.consumeClick()).toBe(false)
  })

  test('a mouse press or a press cut short opens nothing', async () => {
    const { TouchLongPress } = await import('@solus/workspace-ui/components/prs/lib/touch-long-press')
    let opened = 0
    const press = new TouchLongPress(() => { opened += 1 }, 0)

    press.start({ pointerType: 'mouse' } as PointerEvent)
    press.start({ pointerType: 'touch' } as PointerEvent)
    press.cancel()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(opened).toBe(0)
    expect(press.consumeClick()).toBe(false)
  })
})
