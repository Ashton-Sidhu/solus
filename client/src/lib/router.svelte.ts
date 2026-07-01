type Route =
  | { name: 'connect' }
  | { name: 'chat'; tabId?: string }
  | { name: 'plans' }
  | { name: 'settings'; tab?: string }

class Router {
  current: Route = $state(parseHash(location.hash))

  private listener: (() => void) | null = null

  start() {
    this.listener = () => {
      this.current = parseHash(location.hash)
    }
    window.addEventListener('hashchange', this.listener)
    this.current = parseHash(location.hash)
  }

  destroy() {
    if (this.listener) {
      window.removeEventListener('hashchange', this.listener)
      this.listener = null
    }
  }

  navigate(hash: string) {
    if (location.hash === hash) return
    location.hash = hash
  }

  navigateToConnect() {
    this.navigate('#/connect')
  }

  navigateToChat(tabId?: string) {
    this.navigate(tabId ? `#/chat/${tabId}` : '#/chat')
  }

  navigateToPlans() {
    this.navigate('#/plans')
  }

  navigateToSettings(tab?: string) {
    this.navigate(tab ? `#/settings/${tab}` : '#/settings')
  }

  syncTabId(tabId: string) {
    if (this.current.name !== 'chat') return
    if (this.current.tabId === tabId) return
    history.replaceState(null, '', `#/chat/${tabId}`)
    this.current = { name: 'chat', tabId }
  }
}

function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '')

  if (path === 'connect') return { name: 'connect' }
  if (path === 'plans') return { name: 'plans' }
  if (path === 'settings') return { name: 'settings' }
  if (path.startsWith('settings/')) {
    const tab = path.slice(9)
    return { name: 'settings', tab: tab || undefined }
  }
  if (path.startsWith('chat/')) {
    const tabId = path.slice(5)
    return { name: 'chat', tabId: tabId || undefined }
  }

  return { name: 'chat' }
}

export const router = new Router()
export type { Route }
