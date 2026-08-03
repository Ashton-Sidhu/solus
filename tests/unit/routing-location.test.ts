import { describe, expect, test } from 'bun:test'
import { BrowserRouteHistory } from '../../src/renderer/contexts/workspace/routing'

type EventName = 'popstate' | 'hashchange'

class FakeBrowserWindow {
  location = { hash: '#/chat/a' }
  private entries = ['#/chat/a']
  private index = 0
  private listeners: Record<EventName, Set<() => void>> = {
    popstate: new Set(),
    hashchange: new Set(),
  }

  history = {
    pushState: (_data: unknown, _unused: string, url?: string | URL | null) => {
      if (url == null) return
      this.entries.splice(this.index + 1, this.entries.length - this.index - 1, String(url))
      this.index = this.entries.length - 1
      this.location.hash = this.entries[this.index]
    },
    replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => {
      if (url == null) return
      this.entries[this.index] = String(url)
      this.location.hash = this.entries[this.index]
    },
    back: () => {
      if (this.index <= 0) return
      this.index -= 1
      this.location.hash = this.entries[this.index]
      this.emit('popstate')
    },
    forward: () => {
      if (this.index >= this.entries.length - 1) return
      this.index += 1
      this.location.hash = this.entries[this.index]
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

    history.push('#/chat/b')
    history.push('#/settings/general')
    browser.history.back()
    browser.history.back()
    browser.history.forward()

    expect(history.current()).toBe('#/chat/b')
    expect(seen).toEqual(['#/chat/b', '#/settings/general', '#/chat/b', '#/chat/a', '#/chat/b'])
  })

  test('replace after browser back targets the browser current entry', () => {
    const browser = new FakeBrowserWindow()
    const history = new BrowserRouteHistory(browser)
    history.subscribe(() => {})

    history.push('#/chat/b')
    history.push('#/chat/c')
    browser.history.back()

    history.replace('#/settings/keybindings')

    expect(history.current()).toBe('#/settings/keybindings')
    browser.history.back()
    expect(history.current()).toBe('#/chat/a')
    browser.history.forward()
    expect(history.current()).toBe('#/settings/keybindings')
    browser.history.forward()
    expect(history.current()).toBe('#/chat/c')
  })
})
