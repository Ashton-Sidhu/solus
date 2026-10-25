import type { DiscoveredServer, HostOperatingSystem } from './types'
import type { HostRoute } from './host-routes'

/**
 * Adding a machine over SSH, and the forwards that reach a machine with no
 * account (docs/plans/host-routes.md D6, D7, D9).
 */

/** Every server release attaches both installers, so `latest` always resolves. */
export const INSTALL_SCRIPT_URLS = {
  unix: 'https://github.com/Ashton-Sidhu/solus/releases/latest/download/install.sh',
  windows: 'https://github.com/Ashton-Sidhu/solus/releases/latest/download/install.ps1',
} as const

/** An SSH target this host suggests for a discovered server: from `~/.ssh/config`, then `~/.ssh/known_hosts`. */
export interface SshTargetCandidate {
  target: string
  label: string
  source: 'ssh-config' | 'known-hosts'
}

/** The account a new host links to: an enrollment ticket and the account plane that issued it. */
export interface SshAddLink {
  ticket: string
  directoryUrl: string
}

export interface SshAddRequest {
  /** An SSH alias or `user@host`, resolved with this host's SSH configuration. Absent with `discovered`: this host suggests one. */
  sshTarget?: string
  /** A server found on the network, when the person added it from the nearby list. */
  discovered?: DiscoveredServer
  /** A password or key passphrase, read once through askpass. A forward needs key authentication. */
  authSecret?: string
  /** Present: the new host links to the account. Absent: this host holds a forward to it. */
  link?: SshAddLink
  /** Names this device's session on the new host. */
  deviceLabel?: string
  /** Matches the progress events of this request. */
  requestId: string
}

export type SshAddStep = 'connect' | 'check' | 'install' | 'start' | 'identity' | 'link' | 'forward'

/** One step of an add, on the `hostsSshProgress` topic. */
export interface SshAddProgress {
  requestId: string
  step: SshAddStep
  message: string
}

export type SshAddResult =
  /** No target was named for a discovered server, and its SSH configuration names none: the person picks one. */
  | { status: 'needs-target'; candidates: SshTargetCandidate[]; defaultTarget: string; message: string }
  /** SSH refused the key or the secret; the person can give a password or passphrase. */
  | { status: 'needs-auth'; sshTarget: string; message: string }
  /**
   * A discovered server, reached on the network it was found on: the client dials it
   * there with this session, and no forward is needed.
   */
  | { status: 'session'; installationId: string; label: string; os?: HostOperatingSystem; sessionToken: string; identityKey: string }
  /** The host links to the account; the client finds it in the directory. */
  | { status: 'linked'; installationId: string; label: string; os?: HostOperatingSystem }
  /** This host holds a forward to the new host; the session token is this client's credential there. */
  | { status: 'forwarded'; host: ForwardedHost; sessionToken: string }

export type ForwardedHostState = 'open' | 'reconnecting' | 'failed'

/** A host this host reaches through an `ssh -L` forward it holds (D7). */
export interface ForwardedHost {
  installationId: string
  label: string
  sshTarget: string
  os?: HostOperatingSystem
  /** `http://127.0.0.1:<port>` on the holding host, kind `forwarded`. Only that host can dial it. */
  route: HostRoute
  identityKey: string
  state: ForwardedHostState
  /** Why the forward is not open. */
  error?: string
  /** Solus installed the service there, so removing the host stops it. */
  startedBySolus: boolean
  /** The host is also linked to the account: a failed forward is then not an error while the tunnel works (D9). */
  isLinked: boolean
}
