import { accountSettingsDestination } from '@solus/contracts/account-web'
import { parseRoute } from '@solus/workspace-ui/contexts/workspace/routing/codec'
import { ROUTES } from '@solus/workspace-ui/contexts/workspace/routing/route-registry'

/**
 * What the page opens at, so its boot serves that first (docs/plans/instant-share-open.md):
 * the server it needs is dialed before every other and before the directory answers,
 * and a page that opens at a resource neither reads the tab the last visit ended on nor
 * is covered while the account loads.
 */
export interface BootIntent {
  /** The account settings page this address can open with an empty host list. */
  hostlessPage?: 'appearance' | 'agent-profile'
  /** The server the page needs first: the server its address names. */
  firstServerId: string | null
  /** A share link's runner, by its account host id: the directory names the known host it is. */
  runnerHostId?: string | null
  /** The page shows a resource in the leading pane (a share link, a member link), not the conversation. */
  opensResource: boolean
}

/** The intent of the page's own address, as a member link or a reload carries it; including settings a signed-in browser can open without a host. */
export function addressedBootIntent(pathname: string): BootIntent | undefined {
  const accountTab = accountSettingsDestination(pathname)
  if (accountTab) return { firstServerId: null, opensResource: false, hostlessPage: accountTab }
  const ref = parseRoute(pathname)
  if (ref?.name === 'settings' && (ref.params.tab === 'appearance' || ref.params.tab === 'agent-profile')) {
    return { firstServerId: null, opensResource: false, hostlessPage: ref.params.tab }
  }
  const serverId = ref && 'serverId' in ref.params ? ref.params.serverId : undefined
  if (!ref || !serverId) return undefined
  // A surface opens beside the conversation, which still needs the last tab's transcript.
  return { firstServerId: serverId, opensResource: ROUTES[ref.name].placement !== 'surface' }
}
