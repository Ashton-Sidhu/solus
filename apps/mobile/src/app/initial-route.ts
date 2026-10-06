import type { RootStackParamList } from '../navigation/routes'
import type { LastRoute } from './solus-app'

type Route = { [Name in keyof RootStackParamList]: { name: Name; params?: RootStackParamList[Name] } }[keyof RootStackParamList]

/**
 * The stack a launch opens on, decided after the load barrier. With nothing
 * saved, the two ways in; on a returning launch, T3 Code's home (every
 * session on every host), with the last session on top when there was one.
 * Home stays beneath it in both layouts: the iPad sidebar lists the same
 * sessions, and a compact window keeps a way back.
 */
export function initialRoutes(input: { hasHosts: boolean; isSignedIn: boolean; lastRoute: LastRoute | null }): Route[] {
  if (!input.hasHosts && !input.isSignedIn) return [{ name: 'Welcome' }]
  if (!input.hasHosts) return [{ name: 'Hosts' }, { name: 'CloudHosts' }]
  const last = input.lastRoute
  if (!last?.record) return [{ name: 'Home' }]
  return [{ name: 'Home' }, { name: 'Thread', params: { hostId: last.hostId, sessionId: last.record.sessionId } }]
}
