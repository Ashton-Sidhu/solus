import type { BrowserSnapshotRef } from '@solus/contracts/browser-types'
import type { WorkspaceContext } from '../../../contexts/workspace/workspace.context.svelte'
import { browserStore } from '../../../contexts/browser/browser.store.svelte'

/**
 * The way back from a capture to its page: the page in the browser pane, opened
 * again at its address when it has closed since. With `annotate`, the note tools
 * are already armed, so feedback lands on the element rather than on the image.
 */
export async function openSnapshotPage(
  session: Pick<WorkspaceContext, 'openRoute' | 'fallbackServerId'>,
  serverId: string | undefined,
  snapshot: BrowserSnapshotRef,
  options: { annotate?: boolean } = {},
): Promise<void> {
  const host = serverId ?? session.fallbackServerId
  if (options.annotate) {
    void browserStore.setAnnotationTool(browserStore.keyOf(host, snapshot.browserPageId), 'pick').catch(() => {})
  }
  const browserPageId = await browserStore.openSnapshot(host, snapshot)
  session.openRoute({ name: 'browser', params: { browserPageId, serverId: host } }, { via: 'click' })
}

/** Whether the captured page is still open, so Annotate has a page to mark. */
export function isSnapshotPageOpen(serverId: string | undefined, snapshot: BrowserSnapshotRef): boolean {
  return !!serverId && browserStore.pages.has(browserStore.keyOf(serverId, snapshot.browserPageId))
}
