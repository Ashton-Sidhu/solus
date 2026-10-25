import { resourceRoleAtLeast, type ShareLinkTarget, type ShareLinkVisitor } from '@solus/contracts/sharing'
import { standingAllows, type ResourceStanding } from '@solus/contracts/permissions'
import type { HostRoute } from '@solus/contracts/uplink'
import type { Principal } from '../admission/principal'
import type { OpenedLink, ShareManager } from './share-manager'

export interface ShareLinkResolverDeps {
  shares: Pick<ShareManager, 'openLink'>
  /** The routes the directory knows for one host; none when the caller keeps no directory. */
  hostRoutes?(hostId: string): Promise<HostRoute[]>
}

/**
 * The Solus API's answer to a share link (docs/plans/instant-share-open.md): what the
 * secret opens, whom it opens it as, and the host to dial, in one request. The page
 * decides nothing about membership; it boots once, as what this answers.
 */
export class ShareLinkResolver {
  constructor(private readonly deps: ShareLinkResolverDeps) {}

  /**
   * `memberIn` names the visitor as a member of the link's organization, from the
   * access token the page sent; null for a visitor with no token, or one that is not
   * a member there. Null when the secret opens nothing.
   */
  async resolve(secret: string, memberIn: (organizationId: string) => Promise<Principal | null>): Promise<ShareLinkTarget | null> {
    const link = await this.deps.shares.openLink(secret)
    if (!link) return null
    const { share } = link
    const [host, member] = await Promise.all([this.hostOf(link.runnerHostId), memberIn(share.organizationId)])
    return { resource: share.resource, organizationId: share.organizationId, opensAs: visitorOf(link, member), host }
  }

  private async hostOf(hostId: string | null): Promise<ShareLinkTarget['host']> {
    if (!hostId) return null
    return { hostId, routes: this.deps.hostRoutes ? await this.deps.hostRoutes(hostId) : [] }
  }
}

/**
 * A member whose own standing covers everything the link gives opens it as
 * themselves; anyone else as a guest. So a link never gives a member less than a
 * stranger.
 */
function visitorOf(link: OpenedLink, member: Principal | null): ShareLinkVisitor {
  const standing = member ? link.standingOf(member) : null
  const visitor: ShareLinkVisitor = standing && covers(standing, link.share)
    ? { kind: 'member', role: standing.role }
    : { kind: 'guest', role: link.share.role }
  const actions = visitor.kind === 'member' ? standing?.actions : link.share.actions
  if (actions) visitor.actions = [...actions]
  return visitor
}

function covers(standing: ResourceStanding, link: OpenedLink['share']): boolean {
  if (link.role !== 'custom') return standing.role !== 'custom' && resourceRoleAtLeast(standing.role, link.role)
  return standing.role !== 'none' && (link.actions ?? []).every((leaf) => standingAllows(standing, leaf))
}
