import { getSurfaceContext } from '../../../contexts'
import type { PaneId } from '../../../contexts/workspace/routing/location'

/**
 * The controls every pane surface needs, resolved against one pane id: whether
 * it leads the row, whether it is maximized, and the close / maximize commands.
 * The id arrives as a getter, so a surface whose pane changes under it keeps
 * answering for the pane it is in rather than the one it mounted with.
 */
export function paneActions(readPaneId: () => PaneId | undefined) {
  const session = getSurfaceContext().workspace
  // A client with no panes (the cloud console) mounts a surface as a page: it
  // leads nothing, and every positional command is inert.
  if (!session) {
    return {
      inPane: false,
      isLeading: false,
      maximized: false,
      close(): void {},
      toggleMaximize(): void {},
    }
  }
  const router = session.router

  return {
    /** Whether this surface sits in a pane at all. The mobile layout renders pages
     *  inline with no pane of their own, so every positional control below is
     *  meaningless there and must not be offered. */
    get inPane(): boolean {
      const paneId = readPaneId()
      return !!paneId && !!router.pane(paneId)
    },
    get isLeading(): boolean {
      return router.leadingPane.id === readPaneId()
    },
    get maximized(): boolean {
      return session.maximizedPaneId === readPaneId()
    },
    /** Close what this pane shows: the leading pane's destination, or the
     *  companion pane's active surface. */
    close(): void {
      const paneId = readPaneId()
      if (paneId) router.closePane(paneId)
    },
    toggleMaximize(): void {
      const paneId = readPaneId()
      if (!paneId) return
      session.maximizedPaneId = session.maximizedPaneId === paneId ? null : paneId
    },
  }
}
