import type { RootStackParamList } from '../navigation/routes'
import type { LastRoute } from './solus-app'

type Route = { [Name in keyof RootStackParamList]: { name: Name; params?: RootStackParamList[Name] } }[keyof RootStackParamList]

/**
 * The stack a launch opens on, decided after the load barrier. With nothing
 * saved, the two ways in; on a returning launch, the last conversation, with
 * the way back to its sessions and hosts beneath it.
 */
export function initialRoutes(input: { hasHosts: boolean; isSignedIn: boolean; lastRoute: LastRoute | null; compact: boolean }): Route[] {
  if (!input.hasHosts && !input.isSignedIn) return [{ name: 'Welcome' }]
  if (!input.hasHosts) return [{ name: 'Hosts' }, { name: 'CloudHosts' }]
  const last = input.lastRoute
  if (!last) return [{ name: 'Hosts' }]
  const base: Route[] = [
    { name: 'Hosts' },
    { name: 'Projects', params: { hostId: last.hostId } },
  ]
  if (!last.record) return [...base, { name: 'Workspace', params: { hostId: last.hostId, projectPath: last.projectPath } }]
  const selected = { record: last.record }
  if (input.compact) {
    return [
      ...base,
      { name: 'Workspace', params: { hostId: last.hostId, projectPath: last.projectPath } },
      { name: 'Conversation', params: { hostId: last.hostId, projectPath: last.projectPath, selected } },
    ]
  }
  return [...base, { name: 'Workspace', params: { hostId: last.hostId, projectPath: last.projectPath, selected } }]
}
