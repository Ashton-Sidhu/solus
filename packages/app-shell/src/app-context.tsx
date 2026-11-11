import { createContext, useContext } from 'react'
import type { HostTheme } from './host-bridge'

/** One integration the component names, as the server reported it at read time. */
export interface AppRoleState {
  slug: string
  /** The integration's display name, when the viewer has one with this slug. */
  name: string | null
  connected: boolean
}

export interface AppPermissionsState {
  tools: 'all' | 'read-only' | { selected: string[] }
  writes: 'ask' | 'allow'
}

export interface AppState {
  roles: AppRoleState[]
  permissions: AppPermissionsState
  theme: HostTheme
}

export const AppContext = createContext<AppState>({ roles: [], permissions: { tools: 'all', writes: 'ask' }, theme: 'light' })

/** What a component may ask about the app it runs in. */
export function useApp(): AppState {
  return useContext(AppContext)
}
