import { untrack } from 'svelte'
import { SvelteMap } from 'svelte/reactivity'
import { defaultDeviceLabel } from '@solus/client-core/device-label'
import { serverConnections } from '@solus/client-core/server-connections'
import { serverFromSshAdd } from '@solus/client-core/server-registry'
import { sshAddStatusCard } from '@solus/client-core/ssh-progress'
import { unaddedDistros } from '@solus/client-core/wsl-distros'
import { wslHostLabel, type ForwardedHost, type SshAddProgress, type WslDistro, type WslDistroList } from '@solus/contracts/remote-machines'
import type { StatusCardState } from '@solus/contracts/types'
import { hosts, serversStore, uplinkStore } from '../../contexts'
import { forwardedHostsStore } from '../connections/forwarded-hosts.store.svelte'
import { wslAddOutcome } from './lib/add-wsl-distro'
import { messageFor } from './lib/setup-rpc'

/** The distros of one Windows host: being read, read, or why it has none. */
export type DistroListing = { status: 'loading' } | WslDistroList

/** `running` waits on the host; `failed` and `done` show its answer. */
export type AddWslPhase = 'running' | 'failed' | 'done'

/**
 * The WSL distros of a Windows host, offered beside the nearby hosts, and the
 * add of one (docs/plans/windows.md §5.13). The Windows host installs the
 * Linux release of its own version in the distro and holds a forward to it,
 * which also keeps the distro running. The add-host dialog shows the add, and
 * once it is done, a link to the account makes it reachable from every device.
 */
class AddWslDistroStore {
  /** The distros of each Windows host a surface shows; absent until read. */
  readonly listings = new SvelteMap<string, DistroListing>()
  /** The Windows host of the add; null before the first one. */
  hostId = $state<string | null>(null)
  distro = $state('')
  phase = $state<AddWslPhase>('running')
  progress = $state<SshAddProgress[]>([])
  error = $state('')
  resultMessage = $state('')
  /** The host the add made, until it is linked. */
  added = $state<ForwardedHost | null>(null)
  isLinked = $state(false)
  /** Bumped per add, so an answer to a superseded add is dropped. */
  private attempt = 0
  private readonly watchers = new Map<string, number>()

  /** The Windows host this client offers distros of: its own computer, else the host it runs on. */
  get defaultWindowsHostId(): string | null {
    const hostId = (hosts.device ?? hosts.runOn)?.id ?? null
    return hostId && isWindowsHost(hostId) ? hostId : null
  }

  get hostName(): string {
    return this.hostId ? hostLabelOf(this.hostId) : 'the Windows host'
  }

  get isAdding(): boolean {
    return this.hostId !== null && this.phase === 'running'
  }

  /** The distros of the host that it does not reach yet. Empty until both lists are read. */
  addableDistros(hostId: string): WslDistro[] {
    const listing = this.listings.get(hostId)
    const forwarded = forwardedHostsStore.hostsFor(hostId)
    if (listing?.status !== 'ready' || !forwarded) return []
    return unaddedDistros(listing.distros, forwarded)
  }

  /** Reads the distros and the forwards of a Windows host while a surface shows them. The returned function stops it. */
  watch(hostId: string): () => void {
    return untrack(() => {
      if (!isWindowsHost(hostId)) return () => {}
      const stopForwards = forwardedHostsStore.watch(hostId)
      const count = this.watchers.get(hostId) ?? 0
      this.watchers.set(hostId, count + 1)
      // Read again each time a surface opens: a distro can be installed in between.
      if (count === 0) void this.loadDistros(hostId)
      return () => {
        stopForwards()
        const left = (this.watchers.get(hostId) ?? 1) - 1
        if (left > 0) this.watchers.set(hostId, left)
        else this.watchers.delete(hostId)
      }
    })
  }

  /** The add as a setup card, once it has started; null before. */
  get statusCard(): StatusCardState | null {
    if (!this.hostId) return null
    return sshAddStatusCard(this.progress, {
      target: wslHostLabel(this.distro),
      standing: this.phase,
      resultMessage: this.resultMessage,
      error: this.error,
    })
  }

  /** Adds the distro. The add-host dialog shows it; closing the dialog does not stop it. */
  async add(hostId: string, distro: string): Promise<void> {
    if (this.isAdding) return
    const attempt = ++this.attempt
    const requestId = crypto.randomUUID()
    this.hostId = hostId
    this.distro = distro
    this.phase = 'running'
    this.progress = []
    this.error = ''
    this.resultMessage = ''
    this.added = null
    this.isLinked = false
    serversStore.openAddServer('', 'wsl')
    const stopProgress = serverConnections.eventsFor(hostId).subscribe('host.sshProgress', (event) => {
      if (event.requestId === requestId && attempt === this.attempt) this.progress.push(event)
    })
    try {
      const result = await serverConnections.apiFor(hostId).hostsAddWsl({ distro, deviceLabel: defaultDeviceLabel(), requestId })
      if (attempt !== this.attempt) return
      const outcome = wslAddOutcome(result, hostId === hosts.device?.id, hostLabelOf(hostId))
      if (outcome.kind === 'failed' || result.status !== 'forwarded') {
        this.error = outcome.message
        this.phase = 'failed'
        return
      }
      if (outcome.kind === 'save-forwarded') serversStore.savePairedServer(serverFromSshAdd(result, null))
      this.added = result.host
      this.resultMessage = outcome.message
      this.phase = 'done'
      // The distro is a host now: its row leaves the nearby list.
      void forwardedHostsStore.load(hostId)
    } catch (err) {
      if (attempt !== this.attempt) return
      this.error = messageFor(err)
      this.phase = 'failed'
    } finally {
      stopProgress()
    }
  }

  retry(): void {
    if (this.hostId && this.phase === 'failed') void this.add(this.hostId, this.distro)
  }

  /** The added distro can be linked to the account, so every signed-in device reaches it. */
  get canLink(): boolean {
    return uplinkStore.canLink && !!this.added && !this.isLinked
  }

  get isLinking(): boolean {
    return !!this.added && forwardedHostsStore.busyInstallationId === this.added.installationId
  }

  /** Links the added distro. Its forward stays as a route, and it keeps the distro running (D9). */
  async link(): Promise<void> {
    const { hostId, added } = this
    if (!hostId || !added || !this.canLink) return
    this.error = ''
    if (await forwardedHostsStore.link(hostId, added.installationId)) {
      this.isLinked = true
      this.resultMessage = `${added.label} is linked to your Solus account. Every device you sign in on can use it.`
    } else {
      this.error = forwardedHostsStore.errorByInstallation.get(added.installationId) ?? 'The distro is not linked.'
    }
  }

  private async loadDistros(hostId: string): Promise<void> {
    if (!this.listings.has(hostId)) this.listings.set(hostId, { status: 'loading' })
    try {
      this.listings.set(hostId, await serverConnections.apiFor(hostId).hostsListWslDistros())
    } catch (err) {
      this.listings.set(hostId, { status: 'unavailable', message: messageFor(err) })
    }
  }
}

function hostLabelOf(hostId: string): string {
  return serversStore.hostFor(hostId)?.label || 'the Windows host'
}

/** The host runs Windows, so it can have WSL distros. A host known only by id has no system to read. */
export function isWindowsHost(hostId: string): boolean {
  const host = serversStore.hostFor(hostId)
  return !!host && 'os' in host && host.os === 'windows'
}

export const addWslDistroStore = new AddWslDistroStore()
