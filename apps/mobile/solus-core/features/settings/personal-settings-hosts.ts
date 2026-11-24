import { PersonalSettingsHosts, personalSettingsHomeId } from '@solus/client-core/host-personal-settings'
import type { DocumentSyncStorage } from '@solus/client-core/document-sync'
import type { HostConnection } from '../hosts/host-connections'
import type { Listeners } from '../../lib/listeners'
import type { PersonalSettingsStore } from './personal-settings'

export interface PersonalSettingsHostsDeps {
  personal: PersonalSettingsStore
  /** The hosts this device is connected to now. */
  readyConnections(): HostConnection[]
  /** Changes when a host connects or leaves. */
  connectionChanges: Listeners
  /** The phone's default host: its first host. */
  defaultHostId(): string | null
  /** Fires when the settings on screen move to another source, or the account's copy changes. */
  settingsCopyChanges: Listeners
  storage: DocumentSyncStorage
}

/**
 * The person's settings on their hosts, on the phone (ADR 0007,
 * docs/plans/personal-settings-source.md), as `runtime-boot.ts` does it on
 * desktop and web. Signed out, the home host is the source: the phone has no
 * device host, so it is the phone's first host. Signed in, every connected host
 * takes the account's copy. Returns the stop.
 */
export function followPersonalSettingsHosts(deps: PersonalSettingsHostsDeps): () => void {
  const { personal } = deps
  const hosts = new PersonalSettingsHosts({
    readyHosts: () => deps.readyConnections().map((connection) => ({ hostId: connection.hostId, api: connection.api })),
    homeHostId: () => personalSettingsHomeId({ deviceHostId: null, defaultServerId: deps.defaultHostId() }),
    isSignedIn: () => personal.isSignedIn,
    document: () => personal.document(),
    adoptHostCopy: (settings) => personal.adoptHostCopy(settings),
    storage: deps.storage,
  })
  // The home host tells the person's connections when another client changed their copy there.
  let listening: { connection: HostConnection; stop: () => void } | null = null
  const followHomeEvents = () => {
    const homeId = hosts.homeHostId
    const connection = homeId ? deps.readyConnections().find((candidate) => candidate.hostId === homeId) ?? null : null
    if (listening?.connection === connection) return
    listening?.stop()
    listening = connection
      ? { connection, stop: connection.events.subscribe('personalDocument.changed', ({ kind }) => { if (kind === 'settings') hosts.hostChanged(connection.hostId) }) }
      : null
  }
  const refresh = () => {
    hosts.refresh()
    personal.setHomeHostId(hosts.homeHostId)
    followHomeEvents()
  }
  const stops = [
    deps.connectionChanges.subscribe(refresh),
    deps.settingsCopyChanges.subscribe(() => {
      hosts.accountChanged()
      personal.setHomeHostId(hosts.homeHostId)
      followHomeEvents()
    }),
    // Signed in, the person's own change goes to the account, and the hosts follow it.
    personal.onLocalChange((change) => { if (!personal.isSignedIn) hosts.recordLocalChange(change) }),
  ]
  refresh()
  return () => {
    for (const stop of stops) stop()
    listening?.stop()
  }
}
