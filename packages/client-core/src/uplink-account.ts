import type { NativeSolusAPI } from '@solus/contracts/host-api'
import { cookieUplinkAccountSource, probeCloudOrigin, type UplinkAccountSource } from './uplink-session'

/**
 * The one account source this page has, resolved once (decision U9): the native
 * bridge on desktop, the account cookie on the cloud-served web client, nothing
 * anywhere else. `configureUplinkAccountSource` lets the web boot path record what
 * its origin probe found before any host is dialed.
 */

let configuredSource: UplinkAccountSource | null | undefined

function detectSource(): UplinkAccountSource | null {
  // The preload global, not `window.solus`: before a host connects the web client
  // installs a proxy there that answers every name, and would look like a bridge.
  // SAFETY: `solusNative` is what the desktop preload exposes (apps/desktop/src/renderer/env.d.ts);
  // an older preload without the Uplink methods reads as no bridge below.
  const native = (globalThis as { window?: { solusNative?: Partial<NativeSolusAPI> } }).window?.solusNative
  if (!native?.uplinkListDirectoryHosts || !native.uplinkAcquireHostGrant || !native.uplinkIssueEnrollmentTicket) return null
  const { uplinkListDirectoryHosts, uplinkAcquireHostGrant, uplinkIssueEnrollmentTicket } = native
  return {
    listDirectory: () => uplinkListDirectoryHosts(),
    acquireHostGrant: (hostId) => uplinkAcquireHostGrant(hostId),
    issueEnrollmentTicket: () => uplinkIssueEnrollmentTicket(),
  }
}

export function configureUplinkAccountSource(source: UplinkAccountSource | null): void {
  configuredSource = source
}

export function uplinkAccountSource(): UplinkAccountSource | null {
  if (configuredSource === undefined) configuredSource = detectSource()
  return configuredSource
}

/** Web boot: adopt the serving origin as the account source when it is one. */
export async function adoptCloudOriginIfPresent(origin: string): Promise<'signed-in' | 'signed-out' | 'not-cloud'> {
  const verdict = await probeCloudOrigin(origin)
  if (verdict !== 'not-cloud') configureUplinkAccountSource(cookieUplinkAccountSource(origin))
  return verdict
}
