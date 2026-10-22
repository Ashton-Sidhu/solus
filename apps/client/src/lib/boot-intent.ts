import { parseRoute } from '@solus/workspace-ui/contexts/workspace/routing/codec'
import { ROUTES } from '@solus/workspace-ui/contexts/workspace/routing/route-registry'

/**
 * What the page opens at, so its boot serves that first (docs/plans/instant-share-open.md):
 * the server it needs is dialed before every other and before the directory answers,
 * and a page that opens at a resource neither reads the tab the last visit ended on nor
 * is covered while the account loads.
 */
export interface BootIntent {
  /** The server the page needs first: a share link's runner, or the server its address names. */
  firstServerId: string | null
  /** The page shows a resource in the leading pane (a share link, a member link), not the conversation. */
  opensResource: boolean
}

/** The intent of the page's own address, as a member link or a reload carries it; undefined when it names no server. */
export function addressedBootIntent(pathname: string): BootIntent | undefined {
  const ref = parseRoute(pathname)
  const serverId = ref && 'serverId' in ref.params ? ref.params.serverId : undefined
  if (!ref || !serverId) return undefined
  // A surface opens beside the conversation, which still needs the last tab's transcript.
  return { firstServerId: serverId, opensResource: ROUTES[ref.name].placement !== 'surface' }
}
