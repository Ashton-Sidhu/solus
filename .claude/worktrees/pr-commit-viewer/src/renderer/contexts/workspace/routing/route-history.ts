export interface RouteHistory {
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  current(): string
  push(location: string): void
  replace(location: string): void
  back(): boolean
  forward(): boolean
  subscribe(listener: (location: string) => void): () => void
}

type RouteListener = (location: string) => void

export class MemoryRouteHistory implements RouteHistory {
  private entries: string[]
  private index: number
  private readonly listeners = new Set<RouteListener>()

  constructor(
    initialLocation = '/chat',
    private readonly maxEntries = Number.POSITIVE_INFINITY,
  ) {
    this.entries = [initialLocation]
    this.index = 0
  }

  get canGoBack(): boolean {
    return this.index > 0
  }

  get canGoForward(): boolean {
    return this.index < this.entries.length - 1
  }

  current(): string {
    return this.entries[this.index] ?? '/chat'
  }

  push(location: string): void {
    if (this.current() === location) return
    this.entries.splice(this.index + 1, this.entries.length - this.index - 1, location)
    this.index = this.entries.length - 1
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries)
      this.index = this.entries.length - 1
    }
    this.emit()
  }

  replace(location: string): void {
    if (this.current() === location) return
    this.entries[this.index] = location
    this.emit()
  }

  back(): boolean {
    if (!this.canGoBack) return false
    this.index -= 1
    this.emit()
    return true
  }

  forward(): boolean {
    if (!this.canGoForward) return false
    this.index += 1
    this.emit()
    return true
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

  // The browser does not expose its cursor. These answer whether requesting
  // navigation is meaningful; the browser remains authoritative about whether
  // an entry actually exists.
  get canGoBack(): boolean {
    return true
  }

  get canGoForward(): boolean {
    return true
  }

  current(): string {
    return this.browserWindow.location.hash.replace(/^#/, '') || '/chat'
  }

  push(location: string): void {
    if (this.current() === location) return
    this.browserWindow.history.pushState(null, '', `#${location.replace(/^#/, '')}`)
    this.emit()
  }

  replace(location: string): void {
    if (this.current() === location) return
    this.browserWindow.history.replaceState(null, '', `#${location.replace(/^#/, '')}`)
    this.emit()
  }

  back(): boolean {
    this.browserWindow.history.back()
    return true
  }

  forward(): boolean {
    this.browserWindow.history.forward()
    return true
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
