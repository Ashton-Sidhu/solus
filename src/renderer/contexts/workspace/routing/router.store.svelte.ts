import type { SettingsTab } from '../workspace-ui.store.svelte'
import { encodeRoute, parseRouteLocation, type Route } from './route-codec'
import type { RouteHistory } from './route-history'

type RouteTracker = (event: string, properties: Record<string, unknown>) => void

export class RouterStore {
  current: Route = $state({ name: 'chat' })
  private unsubscribeHistory: (() => void) | null = null

  constructor(
    private readonly history: RouteHistory,
    private readonly options: { track?: RouteTracker } = {},
  ) {
    this.current = parseRouteLocation(history.current())
  }

  start(): void {
    if (this.unsubscribeHistory) return
    this.unsubscribeHistory = this.history.subscribe((location) => {
      this.applyLocation(location)
    })
    this.applyLocation(this.history.current())
  }

  destroy(): void {
    this.unsubscribeHistory?.()
    this.unsubscribeHistory = null
  }

  navigate(route: Route): void {
    const location = encodeRoute(route)
    if (this.history.current() === location) return
    this.history.push(location)
  }

  replace(route: Route): void {
    const location = encodeRoute(route)
    if (this.history.current() === location) return
    this.history.replace(location)
  }

  back(): void {
    this.history.back()
  }

  forward(): void {
    this.history.forward()
  }

  navigateToConnect(): void {
    this.navigate({ name: 'connect' })
  }

  navigateToChat(tabId?: string): void {
    this.navigate(tabId ? { name: 'chat', tabId } : { name: 'chat' })
  }

  navigateToSettings(tab?: SettingsTab): void {
    this.navigate(tab ? { name: 'settings', tab } : { name: 'settings' })
  }

  syncTabId(tabId: string): void {
    if (this.current.name !== 'chat') return
    if (this.current.tabId === tabId) return
    this.replace({ name: 'chat', tabId })
  }

  private applyLocation(location: string): void {
    this.current = parseRouteLocation(location)
    this.options.track?.('route_viewed', { route: this.current.name })
  }
}
