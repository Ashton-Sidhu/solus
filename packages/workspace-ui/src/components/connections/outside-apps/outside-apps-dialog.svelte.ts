import { serverConnections } from '@solus/client-core/server-connections'
import { connectionsStore } from '../../../contexts/connections/connections.store.svelte'
import { serversStore } from '../../../contexts/connections/servers.store.svelte'
import { uplinkStore } from '../../../contexts/connections/uplink.store.svelte'
import { hosts } from '../../../contexts/hosts/hosts.svelte'
import { requestInputFocus } from '../../../lib/inputFocus'
import { toasts } from '../../../lib/toasts'
import { claudeMcpAddCommand, copiedMcpAddress } from '../lib/outside-apps'
import { serverIdForAppSignIn, UNKNOWN_HOST_TEXT, type AppSignInLinkTarget } from '../lib/app-sign-in'
import { TURN_ON_POLL_MS, TURN_ON_TIME_LIMIT_MS } from '../lib/outside-apps-gate'
import type { CopiedValueKind } from '../lib/outside-apps-share'

/** The dialog's two views: connect an app (the gate, then App → Access → Connect), or approve an app's sign-in. */
export type OutsideAppsView = 'connect' | 'approve'

/**
 * "Use Solus in other apps" (plans/035 §10): which host its one dialog is open
 * for, and the commands that read what its gate needs. The palette, Sharing &
 * access, and the host menu open it; each client mounts it once
 * (`OutsideAppsDialogHost`). The address and the pairing code are in
 * `connectionsStore`; the registration, the link, and the host's test are in
 * `uplinkStore`. "Approve a sign-in" needs no address, so it skips the gate.
 */
class OutsideAppsDialog {
  /** The host the dialog is open for; null when it is closed. */
  serverId = $state<string | null>(null)
  view = $state<OutsideAppsView>('connect')
  /** The sign-in a link named: the approve view reads it at once instead of asking for a code. */
  signInRequestId = $state<string | null>(null)
  /** "Turn on" was pressed, and the dialog reads the address until it appears or the time limit passes. */
  isTurningOn = $state(false)
  /** A value to copy by hand: the clipboard did not take it. Shown over the dialog, and after the host menu's copy. */
  copyFallback = $state<{ kind: CopiedValueKind; value: string } | null>(null)
  #pollTimer: ReturnType<typeof setInterval> | null = null

  open(serverId: string, { view = 'connect', signInRequestId = null }: { view?: OutsideAppsView; signInRequestId?: string | null } = {}): void {
    this.#stopWaiting()
    this.serverId = serverId
    this.view = view
    this.signInRequestId = signInRequestId
    void this.check(serverId)
  }

  /** Changes the view of the open dialog; the request a link named applies only to the first approve view. */
  show(view: OutsideAppsView): void {
    this.view = view
    this.signInRequestId = null
  }

  /** The client's host for a link's installation id, or null when this client has no connection to it. */
  serverIdForSignIn(hostId: string): string | null {
    return serverIdForAppSignIn(hostId, serversStore.servers)
  }

  /** Opens the sign-in that a `solus://approve-app` link or the web client's query names, on the host it names. */
  openSignInLink(target: AppSignInLinkTarget): void {
    const serverId = this.serverIdForSignIn(target.hostId)
    if (serverId === null) {
      toasts.error(UNKNOWN_HOST_TEXT)
      return
    }
    this.open(serverId, { view: 'approve', signInRequestId: target.requestId })
  }

  /** `refocus`: false when the person goes on to another page ("Manage access"). */
  close({ refocus = true }: { refocus?: boolean } = {}): void {
    this.#stopWaiting()
    this.serverId = null
    this.view = 'connect'
    this.signInRequestId = null
    this.copyFallback = null
    // Typing is the natural next step once the dialog is gone.
    if (refocus) requestInputFocus()
  }

  /** Reads the address and the link, then tests the public address when there is one. "Check again" does this too. */
  async check(serverId: string): Promise<void> {
    await Promise.all([connectionsStore.loadAppEndpoint(serverId), this.#readUplink(serverId)])
    if (this.serverId === serverId && connectionsStore.appEndpoint?.publicUrl) void uplinkStore.runSelfTest(serverId)
  }

  /** The owner's client registers the host, as the Solus Cloud section does, and then reads the gate again. */
  async register(serverId: string): Promise<void> {
    await uplinkStore.register(serverId)
    await this.check(serverId)
  }

  /** Turns the public address on, then reads the address until it appears, for at most `TURN_ON_TIME_LIMIT_MS`. */
  async turnOn(serverId: string): Promise<void> {
    if (this.isTurningOn) return
    this.isTurningOn = true
    await uplinkStore.link(serverId)
    if (this.serverId !== serverId || uplinkStore.statusFor(serverId)?.link.linked !== true) {
      // The link failed; the uplink store said why in a toast.
      this.#stopWaiting()
      return
    }
    const stopAt = Date.now() + TURN_ON_TIME_LIMIT_MS
    this.#pollTimer = setInterval(() => {
      if (this.serverId !== serverId || Date.now() >= stopAt) {
        this.#stopWaiting()
        return
      }
      void connectionsStore.loadAppEndpoint(serverId).then(() => {
        if (this.serverId !== serverId || !connectionsStore.appEndpoint?.publicUrl) return
        this.#stopWaiting()
        void uplinkStore.runSelfTest(serverId)
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

  /** The host menu's "Copy MCP address": the address an app on this computer can use, with an example in the toast. */
  async copyMcpAddress(serverId: string): Promise<void> {
    let endpoint
    try {
      endpoint = await serverConnections.apiFor(serverId).connectionsAppEndpoint()
    } catch (err) {
      toasts.error('Could not read the MCP address', { description: err instanceof Error ? err.message : String(err) })
      return
    }
    const address = copiedMcpAddress(endpoint, isHostComputer(serverId))
    if (!address) {
      toasts.error(`${hostLabel(serverId)} has no public address`, {
        description: 'Apps on this computer need it to reach the host.',
        action: { label: 'Set up', onAction: () => this.open(serverId) },
      })
      return
    }
    if (!(await this.copy('address', address))) return
    toasts.success('MCP address copied', { description: `Add it to an app, for example: ${claudeMcpAddCommand(address)}` })
  }

  /** `refresh` reads the link only for an owner; any other person who uses the host reads it with `readStatus`. */
  async #readUplink(serverId: string): Promise<void> {
    await uplinkStore.refresh(serverId)
    if (uplinkStore.controlFor(serverId) === 'none' || !uplinkStore.statusFor(serverId)) await uplinkStore.readStatus(serverId)
  }

  #stopWaiting(): void {
    if (this.#pollTimer) clearInterval(this.#pollTimer)
    this.#pollTimer = null
    this.isTurningOn = false
  }
}

export const outsideAppsDialog = new OutsideAppsDialog()

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
