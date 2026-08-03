import type { SettingsTab } from '../workspace-ui.store.svelte'

export const SETTINGS_ROUTE_TABS = [
  'general',
  'instructions',
  'review',
  'providers',
  'api-access',
  'tools',
  'skills',
  'voice',
  'experimental',
  'projects',
  'keybindings',
] as const satisfies readonly SettingsTab[]

export type Route =
  | { name: 'connect' }
  | { name: 'chat'; tabId?: string }
  | { name: 'settings'; tab?: SettingsTab }

const SETTINGS_ROUTE_TAB_SET: ReadonlySet<string> = new Set(SETTINGS_ROUTE_TABS)
const DEFAULT_ROUTE: Route = { name: 'chat' }

function isSettingsTab(value: string): value is SettingsTab {
  return SETTINGS_ROUTE_TAB_SET.has(value)
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value)
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function hashPath(location: string): string {
  const hashIndex = location.indexOf('#')
  const rawHash = hashIndex >= 0 ? location.slice(hashIndex + 1) : location
  const queryIndex = rawHash.indexOf('?')
  return (queryIndex >= 0 ? rawHash.slice(0, queryIndex) : rawHash).replace(/^\/?/, '')
}

export function encodeRoute(route: Route): string {
  if (route.name === 'connect') return '#/connect'
  if (route.name === 'settings') {
    return route.tab ? `#/settings/${encodeSegment(route.tab)}` : '#/settings'
  }
  if (route.name === 'chat') {
    return route.tabId ? `#/chat/${encodeSegment(route.tabId)}` : '#/chat'
  }
}

export function parseRouteLocation(location: string): Route {
  const path = hashPath(location)
  if (path === '' || path === 'chat') return { ...DEFAULT_ROUTE }

  const parts: string[] = []
  for (const rawPart of path.split('/')) {
    const decoded = decodeSegment(rawPart)
    if (decoded === null) return { ...DEFAULT_ROUTE }
    parts.push(decoded)
  }

  const [surface, second, ...extra] = parts
  if (extra.length > 0) return { ...DEFAULT_ROUTE }

  if (surface === 'connect' && second === undefined) return { name: 'connect' }

  if (surface === 'chat') {
    return second ? { name: 'chat', tabId: second } : { name: 'chat' }
  }

  if (surface === 'settings') {
    if (second === undefined || second === '') return { name: 'settings' }
    if (!isSettingsTab(second)) return { ...DEFAULT_ROUTE }
    return { name: 'settings', tab: second }
  }

  return { ...DEFAULT_ROUTE }
}
