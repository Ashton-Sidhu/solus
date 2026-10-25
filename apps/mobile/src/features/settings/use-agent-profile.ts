import { useCallback, useMemo, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import type { AgentProfileKey } from '@solus/contracts/agent-profile'
import type { RemoteSkill } from '@solus/contracts/types'
import { sameNameHostAddresses } from '@solus/client-core/host-address'
import { useApp, useListened } from '../../app/app-context'
import type { AgentProfileSetOutcome } from './agent-profile-local'
import type { AgentProfileHostState } from '../account/account-sync'
import { errorMessage, isIntegrationUrl, probeRefusal } from './integrations'
import {
  agentProfileParts,
  integrationEntryFromProbe,
  skillEntryFromRemote,
} from './lib/agent-profile-entries'

/** One host as the profile screen lists it: its copy of the profile, and whether it can be asked now. */
export interface AgentProfileHostRow {
  hostId: string
  label: string
  /** Shown beside the name when another host has the same name. */
  address: string | null
  connected: boolean
  state: AgentProfileHostState
}

/**
 * The agent profile screen's view (plans/020-agent-profile.md §3): the person's
 * instructions, the local copy by part, and its sync status. The phone has no skills CLI
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
    registered.filter((host) => app.connections.state(host.id)?.readiness === 'ready').map((host) => host.id).join('\0'))
  const hosts = useMemo<AgentProfileHostRow[]>(() => {
    const connected = new Set(connectedIds.split('\0').filter(Boolean))
    const addresses = sameNameHostAddresses(registered.map((host) => ({ id: host.id, label: host.label, url: host.routes[0]?.url ?? '' })))
    return registered.map((host) => ({ hostId: host.id, label: host.label, address: addresses.get(host.id) ?? null, connected: connected.has(host.id), state: hostStates.get(host.id) ?? { status: null, error: null, busy: false } }))
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
  const extraInstructions = useListened(app.personal.changes, () => app.personal.current().extraInstructions)
  const modelInstructions = useListened(app.personal.changes, () => app.personal.current().modelInstructions)
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

  /** The person's own instructions: a personal setting every prompt carries, synced like the rest of the profile. */
  const saveExtraInstructions = (text: string) => app.personal.set({ extraInstructions: text })

  /** Instructions added when one model runs, beside the other models' instructions. */
  const saveModelInstructions = (model: string, text: string) =>
    app.personal.set({ modelInstructions: { ...modelInstructions, [model]: text } })

  const removeKeys = (keys: readonly AgentProfileKey[]) => { app.agentProfile.removeKeys(keys) }

  const searchSkills = (query: string): Promise<RemoteSkill[]> => toolApi().skillsSearch(query)

  const addSkill = (skill: RemoteSkill): AgentProfileSetOutcome => app.agentProfile.setEntry(skillEntryFromRemote(skill))

  /** Checks the address on the tool host and adds the server it finds. Answers why when it could not. */
  const addServer = async (url: string): Promise<string | null> => {
    if (!isIntegrationUrl(url)) return 'Use an HTTPS address with no credentials or fragment.'
    // The React Compiler cannot compile branches inside try/catch. The async
    // wrapper turns a synchronous throw into a rejection that catch answers.
    return await (async () => {
      const probe = await toolApi().integrationProbe({ url: url.trim() })
      const refusal = probeRefusal(probe)
      if (refusal) return refusal
      const entry = integrationEntryFromProbe(url, probe)
      if (!entry) return 'This address could not be checked.'
      return app.agentProfile.setEntry(entry) === 'saved' ? null : 'This server could not be added.'
    })().catch(errorMessage)
  }

  return {
    sync,
    status,
    parts,
    hosts,
    connectedHosts,
    toolHost,
    chooseToolHost: setChosenHostId,
    extraInstructions,
    saveExtraInstructions,
    modelInstructions,
    saveModelInstructions,
    removeKeys,
    searchSkills,
    addSkill,
    addServer,
  }
}
