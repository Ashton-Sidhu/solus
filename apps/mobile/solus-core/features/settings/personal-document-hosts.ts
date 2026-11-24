import { PersonalSettingsHosts, personalSettingsHomeId } from '@solus/client-core/host-personal-settings'
import { agentProfileHomeHost } from '@solus/client-core/agent-profile-sync'
import type { DocumentSyncStorage } from '@solus/client-core/document-sync'
import type { PersonalDocumentKind } from '@solus/contracts/settings'
import type { HostConnection } from '../hosts/host-connections'
import type { Listeners } from '../../lib/listeners'
import type { AgentProfileLocalStore } from './agent-profile-local'
import type { PersonalSettingsStore } from './personal-settings'

export interface PersonalDocumentHostsDeps {
  personal: PersonalSettingsStore
  agentProfile: AgentProfileLocalStore
  /** The hosts this device is connected to now. */
  readyConnections(): HostConnection[]
  /** Changes when a host connects or leaves. */
  connectionChanges: Listeners
  /** The phone's default host: its first host. */
  defaultHostId(): string | null
  /** Fires when the documents on screen move to another source, or the account's settings change. */
  settingsCopyChanges: Listeners
  storage: DocumentSyncStorage
}

/**
 * The person's settings and agent profile list on their hosts, on the phone
 * (ADR 0007, docs/plans/personal-settings-source.md), as `runtime-boot.ts` does it
 * on desktop and web. Signed out, the home host is the source: the phone has no
 * device host, so it is the phone's first host. Signed in, every connected host
 * takes the account's settings, and the account sync owner asks the hosts to pull
 * the profile. Returns the stop.
 */
export function followPersonalDocumentHosts(deps: PersonalDocumentHostsDeps): () => void {
  const { personal, agentProfile } = deps
  const homeHostId = () => personalSettingsHomeId({ deviceHostId: null, defaultServerId: deps.defaultHostId() })
  const readyConnection = (hostId: string) => deps.readyConnections().find((connection) => connection.hostId === hostId) ?? null
  const settings = new PersonalSettingsHosts({
    readyHosts: () => deps.readyConnections().map((connection) => ({ hostId: connection.hostId, api: connection.api })),
    homeHostId,
    isSignedIn: () => personal.isSignedIn,
    document: () => personal.document(),
    adoptHostCopy: (copy) => personal.adoptHostCopy(copy),
    storage: deps.storage,
  })
  const profile = agentProfileHomeHost({
    homeHostId: () => agentProfile.isSignedIn ? null : homeHostId(),
    apiFor: (hostId) => readyConnection(hostId)?.api ?? null,
    document: () => agentProfile.document(),
    adopt: (entries) => agentProfile.adoptHostCopy(entries),
    storage: deps.storage,
  })
  const hostChanged = (hostId: string, kind: PersonalDocumentKind) => {
    if (kind === 'settings') settings.hostChanged(hostId)
    else profile.hostChanged(hostId)
  }
  // The home host tells the person's connections when another client changed their copy there.
  let listening: { connection: HostConnection; stop: () => void } | null = null
  const followHomeEvents = () => {
    const homeId = settings.homeHostId
    const connection = homeId ? readyConnection(homeId) : null
    if (listening?.connection === connection) return
    listening?.stop()
    listening = connection
      ? { connection, stop: connection.events.subscribe('personalDocument.changed', ({ kind }) => hostChanged(connection.hostId, kind)) }
      : null
  }
  const refresh = () => {
    settings.refresh()
    profile.refresh()
    personal.setHomeHostId(settings.homeHostId)
    followHomeEvents()
  }
  const stops = [
    deps.connectionChanges.subscribe(refresh),
    deps.settingsCopyChanges.subscribe(() => {
      settings.accountChanged()
      profile.forget()
      refresh()
    }),
    // Signed in, the person's own change goes to the account, and the hosts follow it.
    personal.onLocalChange((change) => { if (!personal.isSignedIn) settings.recordLocalChange(change) }),
    agentProfile.onLocalChange((change) => { if (!agentProfile.isSignedIn) profile.recordLocalChange(change) }),
  ]
  refresh()
  return () => {
    for (const stop of stops) stop()
    listening?.stop()
  }
}
