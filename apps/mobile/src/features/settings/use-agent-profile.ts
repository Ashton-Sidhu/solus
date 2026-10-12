import { useCallback, useMemo, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import type { AgentProfileKey } from '@solus/contracts/agent-profile'
import type { SeatProvider } from '@solus/contracts/seats'
import type { RemoteSkill } from '@solus/contracts/types'
import { useApp, useListened } from '../../app/app-context'
import type { AgentProfileSetOutcome } from './agent-profile-local'
import type { AgentProfileHostState } from './agent-profile-sync'
import { errorMessage, isIntegrationUrl, probeRefusal } from './integrations'
import {
  agentProfileParts,
  fileEntryFromText,
  INSTRUCTION_FILES,
  integrationEntryFromProbe,
  skillEntryFromRemote,
} from './lib/agent-profile-entries'

/** One host as the profile screen lists it: its copy of the profile, and whether it can be asked now. */
export interface AgentProfileHostRow {
  hostId: string
  label: string
  connected: boolean
  state: AgentProfileHostState
}

/**
 * The agent profile screen's view (plans/020-agent-profile.md §3): the local
 * copy by part, its sync, and each host's copy. The phone has no skills CLI
 * and no MCP probe of its own, so a search of skills.sh and a check of a
 * server address go through one connected host, the first unless the person
 * picks another. Each add becomes one entry in the local copy; sync carries it
 * when it is on.
 */
export function useAgentProfile() {
  const app = useApp()
  const sync = app.agentProfileSync
  const status = useListened(sync.changes, sync.current)
  const entries = useListened(app.agentProfile.changes, app.agentProfile.entries)
  const hostStates = useListened(sync.changes, sync.hostStates)
  const registered = useListened(app.registry.changes, app.registry.hosts)
  // A joined string, so the snapshot is stable while no host changes phase.
  const connectedIds = useListened(app.connections.changes, () =>
    registered.filter((host) => app.connections.state(host.id)?.phase === 'connected').map((host) => host.id).join('\0'))
  const [chosenHostId, setChosenHostId] = useState<string | null>(null)

  const parts = useMemo(() => agentProfileParts(entries), [entries])
  const hosts = useMemo<AgentProfileHostRow[]>(() => {
    const connected = new Set(connectedIds.split('\0').filter(Boolean))
    return registered.map((host) => ({ hostId: host.id, label: host.label, connected: connected.has(host.id), state: hostStates.get(host.id) ?? { status: null, error: null, busy: false } }))
  }, [registered, connectedIds, hostStates])
  const connectedHosts = useMemo(() => hosts.filter((host) => host.connected), [hosts])
  const toolHost = connectedHosts.find((host) => host.hostId === chosenHostId) ?? connectedHosts[0] ?? null

  // The screen opened: read the account (ignored while sync is off) and every connected host's copy.
  useFocusEffect(
    useCallback(() => {
      void sync.engine.refresh()
      for (const hostId of connectedIds.split('\0').filter(Boolean)) void sync.load(hostId)
    }, [sync, connectedIds]),
  )

  const toolApi = () => {
    const connection = toolHost ? app.connections.connection(toolHost.hostId) : null
    if (!connection) throw new Error('Connect a host to search skills or check a server.')
    return connection.api
  }

  const saveInstruction = (provider: SeatProvider, text: string): AgentProfileSetOutcome =>
    app.agentProfile.setEntry(fileEntryFromText(provider, INSTRUCTION_FILES[provider], text))

  const removeKeys = (keys: readonly AgentProfileKey[]) => { app.agentProfile.removeKeys(keys) }

  const searchSkills = (query: string): Promise<RemoteSkill[]> => toolApi().skillsSearch(query)

  const addSkill = (skill: RemoteSkill): AgentProfileSetOutcome => app.agentProfile.setEntry(skillEntryFromRemote(skill))

  /** Checks the address on the tool host and adds the server it finds. Answers why when it could not. */
  const addServer = async (url: string): Promise<string | null> => {
    if (!isIntegrationUrl(url)) return 'Use an HTTPS address with no credentials or fragment.'
    try {
      const probe = await toolApi().integrationProbe({ url: url.trim() })
      const refusal = probeRefusal(probe)
      if (refusal) return refusal
      const entry = integrationEntryFromProbe(url, probe)
      if (!entry) return 'This address could not be checked.'
      return app.agentProfile.setEntry(entry) === 'saved' ? null : 'This server could not be added.'
    } catch (cause) {
      return errorMessage(cause)
    }
  }

  return {
    sync,
    status,
    parts,
    hosts,
    connectedHosts,
    toolHost,
    chooseToolHost: setChosenHostId,
    saveInstruction,
    removeKeys,
    searchSkills,
    addSkill,
    addServer,
  }
}
