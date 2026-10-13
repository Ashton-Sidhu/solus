import { useCallback, useMemo, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import type { AgentProfileKey } from '@solus/contracts/agent-profile'
import type { SeatProvider } from '@solus/contracts/seats'
import type { RemoteSkill } from '@solus/contracts/types'
import { useApp, useListened } from '../../app/app-context'
import type { AgentProfileSetOutcome } from './agent-profile-local'
import type { AgentProfileHostState } from '../account/account-sync'
import { errorMessage, isIntegrationUrl, probeRefusal } from './integrations'
import {
  agentProfileParts,
  fileEntryFromText,
  INSTRUCTION_FILES,
  instructionKey,
  integrationEntryFromProbe,
  skillEntryFromRemote,
  withDisabled,
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
 * copy by part, and its sync status. The phone has no skills CLI
 * and no MCP probe of its own, so a search of skills.sh and a check of a
 * server address go through one connected host, the first unless the person
 * picks another. Each add becomes one entry in the local copy; sync carries it
 * when the person is signed in. An entry turned off stays listed and leaves
 * every host.
 */
/**
 * Each host this device knows, with its copy of the profile and whether it can
 * be asked now. Read by the account's sync screen, which lists them, and by the
 * profile screen, which searches and checks through one of them.
 */
export function useAgentProfileHosts() {
  const app = useApp()
  const sync = app.accountSync
  const hostStates = useListened(sync.changes, sync.hostStates)
  const registered = useListened(app.registry.changes, app.registry.hosts)
  // A joined string, so the snapshot is stable while no host changes phase.
  const connectedIds = useListened(app.connections.changes, () =>
    registered.filter((host) => app.connections.state(host.id)?.phase === 'connected').map((host) => host.id).join('\0'))
  const hosts = useMemo<AgentProfileHostRow[]>(() => {
    const connected = new Set(connectedIds.split('\0').filter(Boolean))
    return registered.map((host) => ({ hostId: host.id, label: host.label, connected: connected.has(host.id), state: hostStates.get(host.id) ?? { status: null, error: null, busy: false } }))
  }, [registered, connectedIds, hostStates])

  // The screen opened: every connected host's copy is read.
  useFocusEffect(
    useCallback(() => {
      for (const hostId of connectedIds.split('\0').filter(Boolean)) void sync.load(hostId)
    }, [sync, connectedIds]),
  )

  return { sync, hosts }
}

export function useAgentProfile() {
  const app = useApp()
  const { sync, hosts } = useAgentProfileHosts()
  const status = useListened(sync.changes, sync.currentProfile)
  const entries = useListened(app.agentProfile.changes, app.agentProfile.entries)
  const [chosenHostId, setChosenHostId] = useState<string | null>(null)

  const parts = useMemo(() => agentProfileParts(entries), [entries])
  const connectedHosts = useMemo(() => hosts.filter((host) => host.connected), [hosts])
  const toolHost = connectedHosts.find((host) => host.hostId === chosenHostId) ?? connectedHosts[0] ?? null

  // The screen opened: read the account now rather than at the next poll.
  useFocusEffect(
    useCallback(() => {
      void sync.profileEngine.refresh()
    }, [sync]),
  )

  const toolApi = () => {
    const connection = toolHost ? app.connections.connection(toolHost.hostId) : null
    if (!connection) throw new Error('Connect a host to search skills or check a server.')
    return connection.api
  }

  /** An edit keeps the file off when it was off. */
  const saveInstruction = (provider: SeatProvider, text: string): AgentProfileSetOutcome =>
    app.agentProfile.setEntry(withDisabled(fileEntryFromText(provider, INSTRUCTION_FILES[provider], text), entries[instructionKey(provider)]?.disabled === true))

  const removeKeys = (keys: readonly AgentProfileKey[]) => { app.agentProfile.removeKeys(keys) }

  /** Turns the entries at `keys` off or on in one change; a hand-written skill passes all its files. */
  const setDisabled = (keys: readonly AgentProfileKey[], disabled: boolean) => {
    const changed = keys.flatMap((key) => {
      const entry = entries[key]
      return entry ? [withDisabled(entry, disabled)] : []
    })
    if (changed.length > 0) app.agentProfile.setEntry(changed)
  }

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
    setDisabled,
    searchSkills,
    addSkill,
    addServer,
  }
}
