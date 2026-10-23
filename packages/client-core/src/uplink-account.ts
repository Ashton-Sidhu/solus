import type { NativeSolusAPI } from '@solus/contracts/host-api'
import type { UplinkDirectory } from '@solus/contracts/uplink'
import { configureCloudAccount, oauthCloudAccount, type CloudAccountSession } from './cloud-account'
import type { AccountState } from '@solus/contracts/account-types'
import { isSignedOutState, oauthUplinkAccountSource, type UplinkAccountSource } from './uplink-session'
import { webAccountSession } from './web-sign-in'

/**
 * The one account source this page has, resolved once (decision U9): the native
 * bridge on desktop, the page's own sign-in on the cloud-served web client, nothing
 * anywhere else. `configureUplinkAccountSource` lets the web boot path record the
 * account origin before any host is dialed.
 */

let configuredSource: UplinkAccountSource | null | undefined

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
 * web client; docs/plans/instant-share-open.md): the origin becomes the account
 * source. The page's sign-in (`web-sign-in.ts`) is already resumed; signed in, the
 * directory is read once here, with an account-plane access token.
 */
export async function adoptAccountOrigin(origin: string, accountSession?: CloudAccountSession): Promise<AccountOriginAdoption> {
  const session = accountSession ?? webAccountSession(origin)
  const source = oauthUplinkAccountSource(origin, session)
  configureUplinkAccountSource(source)
  if (session.state().kind !== 'signed-in') return { kind: 'signed-out', directory: null }
  configureCloudAccount(oauthCloudAccount(origin, session))
  return { kind: 'signed-in', directory: await source.listDirectory() }
}
