import { getWorkspaceContext } from '../../../contexts'
import type { PaneId } from '../../../contexts/workspace/routing/location'
import { requestInputFocus } from '../../../lib/inputFocus'

/**
 * The controls every pane surface needs, resolved against one pane id: whether
 * it leads the row, whether it is maximized, and the close / move / maximize
 * commands. Surfaces read these instead of knowing which slot they are in —
 * `isLeading` is the only positional fact any of them actually use, and it
 * still means something once there are more than two panes.
 */
export function paneActions(paneId: PaneId | undefined) {
  const session = getWorkspaceContext()
  const router = session.router

  return {
    /** Whether this surface sits in a pane at all. Pill mode renders the pages
     *  inline with no pane of their own, so every positional control below is
     *  meaningless there and must not be offered. */
    get inPane(): boolean {
      return !!paneId && !!router.pane(paneId)
    },
    get isLeading(): boolean {
      return router.leadingPane.id === paneId
    },
    get maximized(): boolean {
      return session.maximizedPaneId === paneId
    },
    close(): void {
      if (paneId) router.closePane(paneId)
    },
    closeOverlay(): void {
      router.closeOverlay(paneId)
    },
    toggleMaximize(): void {
      if (!paneId) return
      session.maximizedPaneId = session.maximizedPaneId === paneId ? null : paneId
    },
    /** Send this pane's surface one position over — out to a companion pane, or
     *  back into the leading one. Returning to the lead hands focus to the
     *  composer that comes with it. */
    moveAcross(): void {
      if (!paneId) return
      const leading = router.leadingPane.id === paneId
      router.movePane(paneId, leading ? 1 : -1)
      if (leading) requestInputFocus()
    },
  }
}
