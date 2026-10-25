import { answerAgentPersonalRequests } from '@solus/client-core/agent-personal-requests'
import { serverConnections } from '@solus/client-core/server-connections'
import type { AgentDeviceSettingsPatch, AgentProfileWrite } from '@solus/contracts/agent-personal-request'
import { agentProfileSchema } from '@solus/contracts/agent-profile'
import type { PersonalSettingsDocument } from '@solus/contracts/settings'
import type { AgentProfileLocalStore } from '../seats/agent-profile-local.store.svelte'
import { agentDeviceSettingsOf, applyAgentDeviceSettings } from './agent-device-settings.svelte'
import type { SettingsContext } from './settings.context.svelte'

/**
 * Lets every host this client connects to read and change the person's settings,
 * their agent profile, and this device's settings for an agent (docs/settings.md).
 * Each change is a local edit: sync sends a personal or profile change to the
 * account the same way one made in Settings is sent, and a device change stays here.
 */
export function answerAgentPersonalOnEveryHost(settings: SettingsContext, profile: AgentProfileLocalStore): () => void {
  const target = {
    settings: () => $state.snapshot(settings.personal.values),
    applySettings: (patch: PersonalSettingsDocument) => settings.personal.setMany(patch),
    profile: () => profile.storedEntries,
    applyProfile: (change: AgentProfileWrite) => {
      const next = { ...profile.storedEntries, ...change.set }
      for (const key of change.reset) delete next[key]
      if (!agentProfileSchema.safeParse(next).success) return false
      // One change: entries a hand-written skill shares turn on or off together.
      profile.replaceAll(next)
      return true
    },
    device: {
      current: () => agentDeviceSettingsOf(settings),
      apply: (patch: AgentDeviceSettingsPatch) => applyAgentDeviceSettings(settings, patch),
    },
  }
  const stops = new Map<string, () => void>()
  const answer = (serverId: string) => {
    const connection = serverConnections.connectionFor(serverId)
    if (!connection) return
    stops.get(serverId)?.()
    stops.set(serverId, answerAgentPersonalRequests(connection.transport, target))
  }
  for (const serverId of serverConnections.connectedServerIds()) answer(serverId)
  const stopCreated = serverConnections.onConnectionCreated((connection) => answer(connection.serverId))
  return () => {
    stopCreated()
    for (const stop of stops.values()) stop()
    stops.clear()
  }
}
