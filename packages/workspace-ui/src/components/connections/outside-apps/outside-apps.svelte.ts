import { serverConnections } from '@solus/client-core/server-connections'
import { connectionsStore } from '../../../contexts/connections/connections.store.svelte'
import { hostSettingsStore } from '../../../contexts/app/host-settings.store.svelte'
import { serversStore } from '../../../contexts/connections/servers.store.svelte'
import { uplinkStore } from '../../../contexts/connections/uplink.store.svelte'
import { hosts } from '../../../contexts/hosts/hosts.svelte'
import { toasts } from '../../../lib/toasts'
import { claudeMcpAddCommand, copiedMcpAddress } from '../lib/outside-apps'
import { serverIdForAppSignIn, UNKNOWN_HOST_TEXT, type AppSignInLinkTarget } from '../lib/app-sign-in'
import type { AppAddressReach } from '../lib/app-addresses'
import { approveSignInRequest } from '../lib/access-tab-requests.svelte'
import { TURN_ON_POLL_MS, TURN_ON_TIME_LIMIT_MS } from '../lib/outside-apps-gate'
import type { CopiedValueKind } from '../lib/outside-apps-share'

/**
 * The commands of "Use Solus from your other apps" on Settings › Sharing &
 * access (plans/035 §10), shared by its directory, its address ways, and the
 * host menu. The addresses, their tests, Tailscale, and the pairing code are in
 * `connectionsStore`; the registration and the link are in `uplinkStore`; the
 * person's own address is the host setting `publicAddress`. Each client mounts
 * the copy-by-hand dialog once (`OutsideAppsCopyFallbackHost`).
 */
class OutsideApps {
  /** The host whose Solus Cloud address "Turn on" waits for; null when nothing waits. */
  turningOnServerId = $state<string | null>(null)
  /** The address the person uses although the host could not test it from itself (hairpin). */
  acceptedUrl = $state<string | null>(null)
  /** A value to copy by hand: the clipboard did not take it. */
  copyFallback = $state<{ kind: CopiedValueKind; value: string } | null>(null)
  #pollTimer: ReturnType<typeof setInterval> | null = null

  /** Reads the addresses and the link again, and forgets the last tests, so the chosen address is tested again. "Check again" does this. */
  async check(serverId: string): Promise<void> {
    connectionsStore.forgetAppAddressTests(serverId)
    this.acceptedUrl = null
    await Promise.all([connectionsStore.loadAppEndpoint(serverId), this.readUplink(serverId)])
  }

  /** "Go on anyway": the host could not test this address from itself, and the person uses it. */
  goOnUntested(url: string): void {
    this.acceptedUrl = url
  }

  /**
   * Tailscale's "Turn on": Serve gives the host an https address on the tailnet;
   * for an internet address, Funnel then opens it to the internet. Local owner only.
   */
  async turnOnTailscale(serverId: string, reach: AppAddressReach): Promise<void> {
    if (connectionsStore.appTailscaleBusyServerId !== null) return
    const name = hostLabel(serverId)
    const feature = reach === 'internet' ? 'Tailscale Funnel' : 'Tailscale Serve'
    if (connectionsStore.appTailscaleFor(serverId)?.enabled !== true) {
      await connectionsStore.enableAppTailscaleServe(serverId)
    }
    if (reach === 'internet' && !connectionsStore.appTailscaleErrorFor(serverId) && connectionsStore.appTailscaleFor(serverId)?.funnel !== true) {
      await connectionsStore.setAppTailscaleFunnel(serverId, true)
    }

    const error = connectionsStore.appTailscaleErrorFor(serverId) ?? connectionsStore.appTailscaleFor(serverId)?.error
    if (error) {
      toasts.error(`Could not turn on ${feature} on ${name}`, { description: error })
      return
    }
    const endpointError = connectionsStore.appEndpointErrorFor(serverId)
    if (endpointError) {
      toasts.error(`Could not read the Tailscale address for ${name}`, { description: endpointError })
      return
    }
    const address = connectionsStore.appEndpointFor(serverId)?.addresses.find(({ source }) =>
      source === 'tailscale-funnel' || (reach !== 'internet' && source === 'tailscale-serve'),
    )
    if (address) {
      toasts.success(`${feature} is on for ${name}`, { description: address.url })
    } else {
      toasts.info(`Waiting for the Tailscale address for ${name}`, {
        action: { label: 'Check again', onAction: () => void this.check(serverId) },
      })
    }
  }

  /** Saves the person's own https address, reads the addresses again, and tests it. False when the host refused it. */
  async saveAndTestPublicAddress(serverId: string, publicAddress: string): Promise<boolean> {
    await hostSettingsStore.setPublicAddress(serverId, publicAddress.trim())
    if (hostSettingsStore.states.get(serverId)?.error) return false
    await connectionsStore.loadAppEndpoint(serverId)
    if (publicAddress.trim() !== '') await connectionsStore.testAppAddress(serverId, 'custom')
    return true
  }

  /** "Link": the owner's client registers the host, as the Solus Cloud section does, then turns its address on. */
  async link(serverId: string): Promise<void> {
    if (!uplinkStore.statusFor(serverId)?.registration.registered) {
      await uplinkStore.register(serverId)
      await this.check(serverId)
      if (!uplinkStore.statusFor(serverId)?.registration.registered) return
    }
    await this.turnOn(serverId)
  }

  /** Turns the Solus Cloud address on, then reads the addresses until it appears, for at most `TURN_ON_TIME_LIMIT_MS`. */
  async turnOn(serverId: string): Promise<void> {
    if (this.turningOnServerId !== null) return
    this.turningOnServerId = serverId
    await uplinkStore.link(serverId)
    if (uplinkStore.statusFor(serverId)?.link.linked !== true) {
      // The link failed; the uplink store said why in a toast.
      this.#stopWaiting()
      return
    }
    const stopAt = Date.now() + TURN_ON_TIME_LIMIT_MS
    this.#pollTimer = setInterval(() => {
      if (Date.now() >= stopAt) {
        this.#stopWaiting()
        return
      }
      void connectionsStore.loadAppEndpoint(serverId).then(() => {
        if (connectionsStore.appEndpointFor(serverId)?.addresses.some((address) => address.source === 'solus')) this.#stopWaiting()
      })
    }, TURN_ON_POLL_MS)
  }

  /**
   * Copies a value. Where the clipboard does not work (no clipboard API, or the
   * browser refuses), the value shows in a dialog to copy by hand. True when the
   * value is on the clipboard.
   */
  async copy(kind: CopiedValueKind, value: string): Promise<boolean> {
    const isCopied = await writeClipboard(value)
    if (!isCopied) {
      this.copyFallback = { kind, value }
      toasts.info('Clipboard copy is not available', { description: 'Showing the value instead.' })
    }
    return isCopied
  }

  closeCopyFallback(): void {
    this.copyFallback = null
  }

  /** The host menu's "Copy MCP address": the address an app on this computer can use, with an example in the toast. `showPage` opens Sharing & access. */
  async copyMcpAddress(serverId: string, showPage: (serverId: string) => void): Promise<void> {
    let endpoint
    try {
      endpoint = await serverConnections.apiFor(serverId).connectionsAppEndpoint()
    } catch (err) {
      toasts.error('Could not read the MCP address', { description: err instanceof Error ? err.message : String(err) })
      return
    }
    const address = copiedMcpAddress(endpoint, isHostComputer(serverId))
    if (!address) {
      toasts.error(`${hostLabel(serverId)} has no address that this computer reaches`, {
        description: 'Give it one with Solus Cloud, Tailscale, or your own address.',
        action: { label: 'Set up', onAction: () => showPage(serverId) },
      })
      return
    }
    if (!(await this.copy('address', address))) return
    toasts.success('MCP address copied', { description: `Add it to an app, for example: ${claudeMcpAddCommand(address)}` })
  }

  /**
   * Opens the sign-in that a `solus://approve-app` link or the web client's
   * query names: Sharing & access of the host it names, on its approve view.
   */
  openSignInLink(target: AppSignInLinkTarget, showPage: (serverId: string) => void): void {
    const serverId = serverIdForAppSignIn(target.hostId, serversStore.servers)
    if (serverId === null) {
      toasts.error(UNKNOWN_HOST_TEXT)
      return
    }
    approveSignInRequest.ask(serverId, target.requestId)
    showPage(serverId)
  }

  /** Reads where the host's Solus Cloud link stands. `refresh` reads it only for an owner; any other person who uses the host reads it with `readStatus`. */
  async readUplink(serverId: string): Promise<void> {
    await uplinkStore.refresh(serverId)
    if (uplinkStore.controlFor(serverId) === 'none' || !uplinkStore.statusFor(serverId)) await uplinkStore.readStatus(serverId)
  }

  #stopWaiting(): void {
    if (this.#pollTimer) clearInterval(this.#pollTimer)
    this.#pollTimer = null
    this.turningOnServerId = null
  }
}

export const outsideApps = new OutsideApps()

/** The async clipboard API only: a failure must show, so the value can be shown to copy by hand. */
async function writeClipboard(value: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) return false
  return navigator.clipboard.writeText(value).then(() => true, () => false)
}

/** This client runs on the host's computer: the desktop app's own host. An app here reaches the host at its local address. */
export function isHostComputer(serverId: string): boolean {
  return hosts.device?.id === serverId
}

/** The host's name as the host list shows it. */
export function hostLabel(serverId: string): string {
  return serversStore.servers.find((server) => server.id === serverId)?.label ?? 'this host'
}
