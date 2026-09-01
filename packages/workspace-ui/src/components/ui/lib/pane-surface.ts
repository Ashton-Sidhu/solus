import type { PaneId } from '../../../contexts/workspace/routing/location'
import type { RouteParams } from '../../../contexts/workspace/routing/route-registry'

/**
 * The uniform contract every route surface is mounted with. The outlet knows
 * nothing about any particular destination: it hands over the pane's id, the
 * route's params, and the composer actions a conversation-bearing surface needs.
 */
export interface PaneSurfaceProps {
  paneId: PaneId
  surfaceVisible?: boolean
  onAttachFile?: (tabId?: string) => void | Promise<void>
  onScreenshot?: ((tabId?: string) => void | Promise<void>) | null
  onDesignMode?: ((tabId?: string) => void | Promise<void>) | null
}

export type RouteSurfaceProps<K extends keyof RouteParams> = PaneSurfaceProps & {
  params: RouteParams[K]
}

/**
 * What a page gets when either shell may mount it. Editor mode routes it
 * through the pane outlet, which hands over a pane id; pill mode renders the
 * same component inline, where there is no pane at all — so `paneId` is
 * genuinely absent rather than merely unread, and the pane controls that depend
 * on it must not be offered.
 */
export interface InlinePageProps {
  paneId?: PaneId
}
