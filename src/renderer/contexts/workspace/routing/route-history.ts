export interface RouteHistory {
  current(): string
  push(location: string): void
  replace(location: string): void
  back(): void
  forward(): void
  subscribe(listener: (location: string) => void): () => void
}

type RouteListener = (location: string) => void

export class MemoryRouteHistory implements RouteHistory {
  private entries: string[]
  private index: number
  private readonly listeners = new Set<RouteListener>()

  constructor(initialLocation = '#/chat') {
    this.entries = [initialLocation]
    this.index = 0
  }

  current(): string {
    return this.entries[this.index] ?? '#/chat'
  }

  push(location: string): void {
    if (this.current() === location) return
    this.entries.splice(this.index + 1, this.entries.length - this.index - 1, location)
    this.index = this.entries.length - 1
    this.emit()
  }

  replace(location: string): void {
    if (this.current() === location) return
    this.entries[this.index] = location
    this.emit()
  }

  back(): void {
    if (this.index <= 0) return
    this.index -= 1
    this.emit()
  }

  forward(): void {
    if (this.index >= this.entries.length - 1) return
    this.index += 1
    this.emit()
  }

  subscribe(listener: RouteListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    const location = this.current()
    for (const listener of this.listeners) listener(location)
  }
}

interface BrowserHistoryLike {
  pushState(data: unknown, unused: string, url?: string | URL | null): void
  replaceState(data: unknown, unused: string, url?: string | URL | null): void
  back(): void
  forward(): void
}

interface BrowserLocationLike {
  hash: string
  pathname?: string
  search?: string
}

interface BrowserWindowLike {
  location: BrowserLocationLike
  history: BrowserHistoryLike
  addEventListener(type: 'popstate' | 'hashchange', listener: () => void): void
  removeEventListener(type: 'popstate' | 'hashchange', listener: () => void): void
}

export class BrowserRouteHistory implements RouteHistory {
  private readonly listeners = new Set<RouteListener>()
  private readonly onBrowserNavigation = () => this.emit()

  constructor(private readonly browserWindow: BrowserWindowLike = window) {}

  current(): string {
    return this.browserWindow.location.hash || '#/chat'
  }

  push(location: string): void {
    if (this.current() === location) return
    this.browserWindow.history.pushState(null, '', location)
    this.emit()
  }

  replace(location: string): void {
    if (this.current() === location) return
    this.browserWindow.history.replaceState(null, '', location)
    this.emit()
  }

  back(): void {
    this.browserWindow.history.back()
  }

  forward(): void {
    this.browserWindow.history.forward()
  }

  subscribe(listener: RouteListener): () => void {
    if (this.listeners.size === 0) {
      this.browserWindow.addEventListener('popstate', this.onBrowserNavigation)
      this.browserWindow.addEventListener('hashchange', this.onBrowserNavigation)
    }
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        this.browserWindow.removeEventListener('popstate', this.onBrowserNavigation)
        this.browserWindow.removeEventListener('hashchange', this.onBrowserNavigation)
      }
    }
  }

  private emit(): void {
    const location = this.current()
    for (const listener of this.listeners) listener(location)
  }
}
