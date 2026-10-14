import type { NativeSolusAPI } from '@solus/contracts/host-api'
import type { UplinkDirectory } from '@solus/contracts/uplink'
import { configureCloudAccount, oauthCloudAccount, type CloudAccountSession } from './cloud-account'
import { isCloudOrigin, oauthUplinkAccountSource, type UplinkAccountSource } from './uplink-session'
import { webAccountSession } from './web-sign-in'

/**
 * The one account source this page has, resolved once (decision U9): the native
 * bridge on desktop, the page's own sign-in on the cloud-served web client, nothing
 * anywhere else. `configureUplinkAccountSource` lets the web boot path record what
 * its origin probe found before any host is dialed.
 */

let configuredSource: UplinkAccountSource | null | undefined

function detectSource(): UplinkAccountSource | null {
  // The preload global, not `window.solus`: before a host connects the web client
  // installs a proxy there that answers every name, and would look like a bridge.
  // SAFETY: `solusNative` is what the desktop preload exposes (apps/desktop/src/renderer/env.d.ts).
  const native = (globalThis as { window?: { solusNative?: NativeSolusAPI } }).window?.solusNative
  if (!native) return null
  return {
    listDirectory: () => native.uplinkListDirectory(),
    accessToken: (resource, options) => native.accountAccessToken(resource, options),
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

const cloudOrigins = new Map<string, Promise<boolean>>()

/** Whether the page's serving origin is a Solus account origin; asked once per origin. */
export function servingOriginIsCloud(origin: string): Promise<boolean> {
  let answer = cloudOrigins.get(origin)
  if (!answer) {
    answer = isCloudOrigin(origin)
    cloudOrigins.set(origin, answer)
  }
  return answer
}

export interface CloudOriginProbe {
  kind: 'signed-in' | 'signed-out' | 'not-cloud'
  /** The directory when signed in and the account origin answered. */
  directory: UplinkDirectory | null
}

/**
 * Web boot: adopt the serving origin as the account source when it is one. The page's
 * sign-in (`web-sign-in.ts`) is already resumed; signed in, the directory is read once
 * here, with an account-plane access token.
 */
export async function adoptCloudOriginIfPresent(origin: string, accountSession?: CloudAccountSession): Promise<CloudOriginProbe> {
  if (!(await servingOriginIsCloud(origin))) return { kind: 'not-cloud', directory: null }
  const session = accountSession ?? webAccountSession(origin)
  const source = oauthUplinkAccountSource(origin, session)
  configureUplinkAccountSource(source)
  if (session.state().kind !== 'signed-in') return { kind: 'signed-out', directory: null }
  configureCloudAccount(oauthCloudAccount(origin, session))
  return { kind: 'signed-in', directory: await source.listDirectory() }
}
