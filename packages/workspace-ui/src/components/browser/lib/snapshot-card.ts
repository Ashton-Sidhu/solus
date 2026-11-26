import type { BrowserSnapshotRef } from '@solus/contracts/browser-types'

/**
 * The address, as the viewer states it under the capture's name.
 *
 * Two worktrees serving the same app produce identical screenshots and differ
 * only by port, so the host is the one thing that says which of them this is.
 * The scheme is never the interesting part and a bare host loses which route was
 * captured, so the two are shown together with the scheme dropped — the same
 * reading order the pane's own address field uses.
 */
export function snapshotAddress(snapshot: BrowserSnapshotRef): string {
  try {
    const url = new URL(snapshot.url)
    return `${url.host}${url.pathname}${url.search}`
  } catch {
    return snapshot.url
  }
}

/** The capture as a gallery path: the asset the media viewer loads, and the key
 *  by which the viewer finds the capture again to offer its page actions. */
export function snapshotHref(snapshot: BrowserSnapshotRef): string {
  return `asset://${snapshot.assetId}`
}
