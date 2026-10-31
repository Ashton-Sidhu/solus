import type { NativeSolusAPI } from '@solus/contracts/host-api'
import type { DirectoryResponse, UplinkDirectory } from '@solus/contracts/uplink'
import { configureCloudAccount, webCloudAccount, type CloudAccountSession } from './cloud-account'
import type { AccountState } from '@solus/contracts/account-types'
import { isSignedOutState, webUplinkAccountSource, type UplinkAccountSource } from './uplink-session'

/**
 * The one account source this page has, resolved once (decision U9): the native
 * bridge on desktop, the page's `WebTokenSession` on the cloud-served web client,
 * nothing anywhere else. `configureUplinkAccountSource` lets the web boot path record
 * the account origin before any host is dialed.
 */

let configuredSource: UplinkAccountSource | null | undefined
let startupDirectory: Promise<UplinkDirectory | null> | null = null

function detectSource(): UplinkAccountSource | null {
  // The preload global, not `window.solus`: before a host connects the web client
  // installs a proxy there that answers every name, and would look like a bridge.
  // SAFETY: `solusNative` is what the desktop preload exposes (apps/desktop/src/renderer/env.d.ts).
  const native = (globalThis as { window?: { solusNative?: NativeSolusAPI } }).window?.solusNative
  if (!native) return null
  // Main holds the sign-in and pushes each change. Until it first answers, no dial is blocked on a guess.
  let state: AccountState | undefined
  native.onAccountStateChange((next) => { state = next })
  void native.accountState().then((next) => { state ??= next }, () => {})
  return {
    listDirectory: () => native.uplinkListDirectory(),
    accessToken: (resource, options) => native.accountAccessToken(resource, options),
    isSignedOut: () => isSignedOutState(state),
    issueEnrollmentTicket: () => native.uplinkIssueEnrollmentTicket(),
    loadOrganizationDirectory: (organizationId) => native.uplinkOrganizationDirectory(organizationId),
    startManagedHost: (hostId) => native.uplinkStartManagedHost(hostId),
    removeHost: (hostId) => native.uplinkRemoveHost(hostId),
  }
}

export function configureUplinkAccountSource(source: UplinkAccountSource | null): void {
  configuredSource = source
  startupDirectory = null
}

/** Hand web boot's first directory read to the mounted connections store once.
 * Later refreshes still ask the account for current hosts. */
export function takeStartupDirectoryRead(): Promise<UplinkDirectory | null> | null {
  const read = startupDirectory
  startupDirectory = null
  return read
}

export function uplinkAccountSource(): UplinkAccountSource | null {
  if (configuredSource === undefined) configuredSource = detectSource()
  return configuredSource
}

export interface AccountOriginAdoption {
  kind: 'signed-in' | 'signed-out'
  /** The directory when signed in and the account origin answered. */
  directory: UplinkDirectory | null
}

/**
 * Web boot on the account origin, which its shell names (`accountOriginShell` in the
 * web client; docs/plans/fast-secure-startup.md): the origin becomes the account source
 * at once, so hosts dial now and their tokens come with the session's first answer.
 * The directory is the shell's when it carries one, with no request; else it is read
 * once here, with the first answer's directory or `GET /v1/hosts`. A page with no
 * session (a guest on a share link) is signed out.
 */
export async function adoptAccountOrigin(origin: string, session: CloudAccountSession | null, shellDirectory?: DirectoryResponse): Promise<AccountOriginAdoption> {
  if (!session) {
    configureUplinkAccountSource(null)
    return { kind: 'signed-out', directory: null }
  }
  const source = webUplinkAccountSource(origin, session)
  configureUplinkAccountSource(source)
  configureCloudAccount(webCloudAccount(origin, session))
  startupDirectory = shellDirectory ? Promise.resolve({ directoryUrl: origin, ...shellDirectory }) : source.listDirectory()
  return { kind: 'signed-in', directory: await startupDirectory }
}
