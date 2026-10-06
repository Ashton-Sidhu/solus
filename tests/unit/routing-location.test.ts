import { beforeAll, describe, expect, test } from 'bun:test'
import { BrowserRouteHistory } from '@solus/workspace-ui/contexts/workspace/routing/route-history'
import {
  activeSurface,
  applyLocation,
  closeSurface,
  closeSurfacesWhere,
  initialLocation,
  makePane,
  openDestination,
  openSurface,
  targetFor,
  type Location,
} from '@solus/workspace-ui/contexts/workspace/routing/location'
import { CHAT_ROUTE, chatRoute, type RouteRef } from '@solus/workspace-ui/contexts/workspace/routing/route-registry'

// The open rules of docs/plans/companion-surfaces.md, one pure function each.
// A destination owns the leading pane; a surface joins the strip beside it.

const TASKS: RouteRef = { name: 'tasks', params: {} }
const PRS: RouteRef = { name: 'prs', params: {} }
const TASK: RouteRef = { name: 'task', params: { taskId: 't_1' } }
const WORK: RouteRef = { name: 'work', params: { workId: 'w_1' } }
const PLAN: RouteRef = { name: 'plan', params: { planId: 'p_1' } }
const SESSION_CHAT = chatRoute('s_2', 'host-a')

function locationWith(destination: RouteRef, surfaces: RouteRef[] = [], activeSurfaceIndex = surfaces.length - 1): Location {
  const panes = [makePane([destination])]
  if (surfaces.length > 0) panes.push(makePane(surfaces, activeSurfaceIndex))
  return { panes, focusedPaneId: panes[0].id }
}

function stripOf(location: Location): RouteRef[] {
  return location.panes[1]?.surfaces ?? []
}

describe('where a route goes', () => {
  test('a page is a destination, a record beside it is a surface, a conversation may be either', () => {
    expect(targetFor(TASKS, 'companion')).toBe('leading')
    expect(targetFor(TASK, 'leading')).toBe('companion')
    expect(targetFor(SESSION_CHAT)).toBe('leading')
    expect(targetFor(SESSION_CHAT, 'companion')).toBe('companion')
  })
})

describe('opening a destination', () => {
  test('replaces what the leading pane holds and takes focus, leaving the strip alone', () => {
    const location = locationWith(TASKS, [TASK])
    location.focusedPaneId = location.panes[1].id
    const companion = location.panes[1]

    openDestination(location, PRS)

    expect(location.panes[0].surfaces).toEqual([PRS])
    expect(location.focusedPaneId).toBe(location.panes[0].id)
    // The strip is the router's to swap; the location rule does not touch it.
    expect(location.panes[1]).toBe(companion)
  })
})

describe('opening a surface', () => {
  test('opens the companion pane with that one surface when there is none', () => {
    const location = initialLocation()

    const pane = openSurface(location, TASK)

    expect(stripOf(location)).toEqual([TASK])
    expect(pane.activeSurfaceIndex).toBe(0)
    expect(location.focusedPaneId).toBe(pane.id)
  })

  test('a different subject opens to the right of the surface the user is in', () => {
    // WHY: from the task beside the board, its session opens next to the task
    // and the task stays (rule 4) — it does not replace the task.
    const location = locationWith(TASKS, [TASK, WORK], 0)

    openSurface(location, SESSION_CHAT)

    expect(stripOf(location)).toEqual([TASK, SESSION_CHAT, WORK])
    expect(location.panes[1].activeSurfaceIndex).toBe(1)
  })

  test('the same subject is one surface: it becomes active and takes the new detail', () => {
    const fileAt = (line: number): RouteRef => ({ name: 'files', params: { serverId: 'h', cwd: '/repo', path: 'a.ts', line } })
    const location = locationWith(CHAT_ROUTE, [fileAt(3), WORK], 1)

    openSurface(location, fileAt(40))

    expect(stripOf(location)).toEqual([fileAt(40), WORK])
    expect(location.panes[1].activeSurfaceIndex).toBe(0)
  })

  test('a review is one surface per conversation, whichever face it shows', () => {
    const review = (view: 'diff' | 'guide'): RouteRef => ({ name: 'review', params: { sourceTabId: 'tab_a', view } })
    const location = locationWith(CHAT_ROUTE, [review('diff')])

    openSurface(location, review('guide'))

    expect(stripOf(location)).toEqual([review('guide')])
  })

  test('a subject that is already the destination focuses the leading pane instead', () => {
    const record: RouteRef = { name: 'sessionRecord', params: { sessionId: 's_9', serverId: 'host-a' } }
    const location = locationWith(record)

    openSurface(location, record)

    expect(location.panes).toHaveLength(1)
    expect(location.focusedPaneId).toBe(location.panes[0].id)
  })

  test('a background open joins the strip without moving the reader', () => {
    const location = locationWith(CHAT_ROUTE, [TASK])
    const focusedBefore = location.focusedPaneId

    openSurface(location, PLAN, { background: true })

    expect(stripOf(location)).toEqual([TASK, PLAN])
    expect(activeSurface(location.panes[1])).toEqual(TASK)
    expect(location.focusedPaneId).toBe(focusedBefore)
  })

  test('in place replaces the active surface: a draft becomes its conversation', () => {
    const draft: RouteRef = { name: 'draft', params: { draftId: 'd_1' } }
    const location = locationWith(CHAT_ROUTE, [TASK, draft])

    openSurface(location, SESSION_CHAT, { inPlace: true })

    expect(stripOf(location)).toEqual([TASK, SESSION_CHAT])
  })

  test('the leading pane keeps its object identity when a surface opens', () => {
    const location = locationWith(CHAT_ROUTE, [TASK])
    const leading = location.panes[0]

    openSurface(location, WORK)

    expect(location.panes[0]).toBe(leading)
  })
})

describe('closing surfaces', () => {
  test('closing the active surface activates its right neighbour', () => {
    const location = locationWith(CHAT_ROUTE, [TASK, WORK, PLAN], 1)

    closeSurface(location, 1)

    expect(stripOf(location)).toEqual([TASK, PLAN])
    expect(activeSurface(location.panes[1])).toEqual(PLAN)
  })

  test('closing the last surface in the row activates its left neighbour', () => {
    const location = locationWith(CHAT_ROUTE, [TASK, WORK], 1)

    closeSurface(location, 1)

    expect(activeSurface(location.panes[1])).toEqual(TASK)
  })

  test('closing a surface to the left keeps the reader on the same surface', () => {
    const location = locationWith(CHAT_ROUTE, [TASK, WORK, PLAN], 2)

    closeSurface(location, 0)

    expect(activeSurface(location.panes[1])).toEqual(PLAN)
  })

  test('closing the only surface closes the companion pane and returns focus to the lead', () => {
    const location = locationWith(CHAT_ROUTE, [TASK])
    location.focusedPaneId = location.panes[1].id

    closeSurface(location, 0)

    expect(location.panes).toHaveLength(1)
    expect(location.focusedPaneId).toBe(location.panes[0].id)
  })

  test('closing by predicate closes only what it names', () => {
    const location = locationWith(CHAT_ROUTE, [TASK, WORK, PLAN], 0)

    closeSurfacesWhere(location, (ref) => ref.name === 'work')

    expect(stripOf(location)).toEqual([TASK, PLAN])
    expect(activeSurface(location.panes[1])).toEqual(TASK)
  })
})

describe('applying a location', () => {
  test('reuses panes by position so geometry and DOM survive back/forward', () => {
    const location = locationWith(CHAT_ROUTE, [TASK])
    const leading = location.panes[0]
    const companion = location.panes[1]

    applyLocation(location, locationWith(CHAT_ROUTE, [TASK, WORK], 0))

    expect(location.panes[0]).toBe(leading)
    expect(location.panes[1]).toBe(companion)
    expect(location.panes[1].surfaces).toEqual([TASK, WORK])
    expect(location.panes[1].activeSurfaceIndex).toBe(0)
  })

  test('drops the companion pane the incoming location does not have', () => {
    const location = locationWith(CHAT_ROUTE, [TASK])

    applyLocation(location, locationWith(CHAT_ROUTE))

    expect(location.panes).toHaveLength(1)
    expect(location.focusedPaneId).toBe(location.panes[0].id)
  })
})

type EventName = 'popstate' | 'hashchange'

class FakeBrowserWindow {
  location = { hash: '', pathname: '/', search: '' }
  private entries: string[]
  private index = 0
  private listeners: Record<EventName, Set<() => void>> = {
    popstate: new Set(),
    hashchange: new Set(),
  }

  constructor(initialUrl = '/chat/a') {
    this.entries = [initialUrl]
    this.setLocation(initialUrl)
  }

  private setLocation(path: string): void {
    const url = new URL(path, 'https://app.solus.sh')
    this.location.hash = url.hash
    this.location.pathname = url.pathname
    this.location.search = url.search
  }

  history = {
    pushState: (_data: unknown, _unused: string, url?: string | URL | null) => {
      if (url == null) return
      this.entries.splice(this.index + 1, this.entries.length - this.index - 1, String(url))
      this.index = this.entries.length - 1
      this.setLocation(this.entries[this.index])
    },
    replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => {
      if (url == null) return
      this.entries[this.index] = String(url)
      this.setLocation(this.entries[this.index])
    },
    back: () => {
      if (this.index <= 0) return
      this.index -= 1
      this.setLocation(this.entries[this.index])
      this.emit('popstate')
    },
    forward: () => {
      if (this.index >= this.entries.length - 1) return
      this.index += 1
      this.setLocation(this.entries[this.index])
      this.emit('popstate')
    },
  }

  addEventListener(type: EventName, listener: () => void): void {
    this.listeners[type].add(listener)
  }

  removeEventListener(type: EventName, listener: () => void): void {
    this.listeners[type].delete(listener)
  }

  private emit(type: EventName): void {
    for (const listener of this.listeners[type]) listener()
  }
}

describe('route history adapters', () => {
  test('BrowserRouteHistory follows native browser back and forward', () => {
    const browser = new FakeBrowserWindow()
    const history = new BrowserRouteHistory(browser)
    const seen: string[] = []
    history.subscribe((location) => seen.push(location))

    history.push('/chat/b')
    history.push('/settings/general')
    browser.history.back()
    browser.history.back()
    browser.history.forward()

    expect(history.current()).toBe('/chat/b')
    expect(seen).toEqual(['/chat/b', '/settings/general', '/chat/b', '/chat/a', '/chat/b'])
  })

  test('replace after browser back targets the browser current entry', () => {
    const browser = new FakeBrowserWindow()
    const history = new BrowserRouteHistory(browser)
    history.subscribe(() => {})

    history.push('/chat/b')
    history.push('/chat/c')
    browser.history.back()

    history.replace('/settings/keybindings')

    expect(history.current()).toBe('/settings/keybindings')
    browser.history.back()
    expect(history.current()).toBe('/chat/a')
    browser.history.forward()
    expect(history.current()).toBe('/settings/keybindings')
    browser.history.forward()
    expect(history.current()).toBe('/chat/c')
  })
})

let RouterStore: typeof import('@solus/workspace-ui/contexts/workspace/routing/router.store.svelte').RouterStore

beforeAll(async () => {
  // These checks exercise route ownership, not Svelte reactivity.
  Object.assign(globalThis, { $state: <T>(value: T) => value })
  ;({ RouterStore } = await import('@solus/workspace-ui/contexts/workspace/routing/router.store.svelte'))
})

describe('web address bar', () => {
  function bind(browser: FakeBrowserWindow) {
    const previousWindow = globalThis.window
    Object.assign(globalThis, { window: browser })
    const router = new RouterStore()
    router.navigate(TASKS)
    try {
      router.bindAddressBar()
    } finally {
      Object.assign(globalThis, { window: previousWindow })
    }
    return router
  }

  test('a direct path takes priority over saved state and restores all panes on refresh', () => {
    const browser = new FakeBrowserWindow('/settings/general?p=work%2Fw_12&f=1')
    const router = bind(browser)
    expect(router.at('settings')).toBe(true)
    expect(router.at('work')).toBe(true)
    expect(activeSurface(router.focused)?.name).toBe('work')
    expect(browser.location.hash).toBe('')
    const reloaded = bind(new FakeBrowserWindow(browser.location.pathname + browser.location.search))
    expect(reloaded.serialized).toBe(router.serialized)
    router.destroy()
    reloaded.destroy()
  })

  test('root restores the saved workspace', () => {
    const browser = new FakeBrowserWindow('/')
    const router = bind(browser)
    expect(router.at('tasks')).toBe(true)
    expect(browser.location.pathname).toBe('/tasks')
    router.destroy()
  })

  test('old hash links become paths without adding a history entry', () => {
    const browser = new FakeBrowserWindow('/#/settings/general?p=work%2Fw_12&f=1')
    const router = bind(browser)
    expect(router.at('settings')).toBe(true)
    expect(browser.location.pathname).toBe('/settings/general')
    expect(browser.location.hash).toBe('')
    router.navigate(PRS)
    browser.history.back()
    expect(router.at('settings')).toBe(true)
    browser.history.back()
    expect(browser.location.pathname).toBe('/settings/general')
    router.destroy()
  })

  test('native Back and Forward update the rendered route', () => {
    const browser = new FakeBrowserWindow('/tasks')
    const router = bind(browser)
    router.navigate(PRS)
    expect(browser.location.pathname).toBe('/prs')
    expect(browser.location.hash).toBe('')
    browser.history.back()
    expect(router.at('tasks')).toBe(true)
    browser.history.forward()
    expect(router.at('prs')).toBe(true)
    router.destroy()
  })

  test('secret fragments are not interpreted as workspace navigation', () => {
    const browser = new FakeBrowserWindow('/w/resource#' + 's'.repeat(32))
    expect(new BrowserRouteHistory(browser).current()).toBe('/w/resource')
  })
})
