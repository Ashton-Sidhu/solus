import { answerAgentSettingsRequests } from '@solus/client-core/agent-settings-requests'
import { serverConnections } from '@solus/client-core/server-connections'
import type { PersonalSettingsDocument } from '@solus/contracts/settings'
import type { PersonalSettingsStore } from './personal-settings.store.svelte'

/**
 * Lets every host this client connects to read and change the person's settings
 * for an agent (docs/settings.md). Each change is a local edit, so sync sends it
 * to the account the same way one made in Settings is sent.
 */
export function answerAgentSettingsOnEveryHost(personal: PersonalSettingsStore): () => void {
  const target = {
    current: () => $state.snapshot(personal.values),
    apply: (patch: PersonalSettingsDocument) => personal.setMany(patch),
  }
  const stops = new Map<string, () => void>()
  const answer = (serverId: string) => {
    const connection = serverConnections.connectionFor(serverId)
    if (!connection) return
    stops.get(serverId)?.()
    stops.set(serverId, answerAgentSettingsRequests(connection.transport, target))
  }
  for (const serverId of serverConnections.connectedServerIds()) answer(serverId)
  const stopCreated = serverConnections.onConnectionCreated((connection) => answer(connection.serverId))
  return () => {
    stopCreated()
    for (const stop of stops.values()) stop()
    stops.clear()
  }
}
