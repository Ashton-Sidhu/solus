import type { ShareLinkResolution } from '@solus/client-core/guest-link'
import type { GuestLink } from '@solus/contracts/sharing'
import { solusApiId, type HostRoute } from '@solus/contracts/uplink'
import { appLinkUrl } from '@solus/workspace-ui/contexts/sharing/app-link'

/**
 * What a share link opens on this page (docs/plans/instant-share-open.md), from the
 * one resolve answer. The page boots once, as this says: a member goes straight to
 * the resource in the whole app, a guest to the guest shell.
 *
 * - `member`: the app's own address for the resource on its organization's
 *   workspace service, and the host that runs it, which the boot dials first.
 * - `guest`: the routes of the host that runs it, dialed first, and the Solus API's
 *   copy to read when that host does not answer (`mirror`; null on a host origin).
 */
export type ShareLinkOpening =
  | { kind: 'member'; address: string; runnerHostId: string | null }
  | { kind: 'guest'; host: HostRoute[]; mirror: string | null }
  | { kind: 'failed'; reason: string }

/** What the guest landing works from: the dial, or why there is none. */
export type GuestOpening = Exclude<ShareLinkOpening, { kind: 'member' }>

/**
 * A host has no resolve door and answers its unnamed 404 (`no-door`): the page is
 * served by the host that holds the resource, and dials it with the secret alone.
 */
export function shareLinkOpening(resolution: ShareLinkResolution, link: GuestLink, origin: string): ShareLinkOpening {
  if (resolution.kind === 'no-door') return { kind: 'guest', host: [{ kind: 'direct', url: origin }], mirror: null }
  if (resolution.kind === 'unknown-link') return { kind: 'failed', reason: 'This link does not open anything. Ask for the current link.' }
  const { target } = resolution
  if (target.opensAs.kind === 'member') {
    return { kind: 'member', address: appLinkUrl(origin, link.resource, solusApiId(target.organizationId)), runnerHostId: target.host?.hostId ?? null }
  }
  return { kind: 'guest', host: target.host?.routes ?? [], mirror: origin }
}
