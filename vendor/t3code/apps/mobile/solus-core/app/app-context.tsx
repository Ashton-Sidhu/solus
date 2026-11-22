import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'
import type { Listeners } from '../lib/listeners'
import type { SolusApp } from './solus-app'

const AppContext = createContext<SolusApp | null>(null)

export function AppProvider({ app, children }: { app: SolusApp; children: ReactNode }) {
  return <AppContext.Provider value={app}>{children}</AppContext.Provider>
}

export function useApp(): SolusApp {
  const app = useContext(AppContext)
  if (!app) throw new Error('useApp outside AppProvider')
  return app
}

/** Re-renders when `listeners` fire and `read` answers a different value. */
export function useListened<T>(listeners: Listeners, read: () => T): T {
  return useSyncExternalStore(listeners.subscribe, read, read)
}
