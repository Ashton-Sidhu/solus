import { resourceRoleAtLeast, type ShareLinkTarget, type ShareLinkVisitor } from '@solus/contracts/sharing'
import type { HostRoute } from '@solus/contracts/uplink'
import type { Principal } from '../admission/principal'
import type { ResolvedLinkShare, ShareManager } from './share-manager'

export interface ShareLinkResolverDeps {
  shares: Pick<ShareManager, 'resolveLinkSecret' | 'roleFor'>
  /** The host that runs a session of this organization, as its record names it; null when none does. */
  runnerOf(organizationId: string, sessionId: string): Promise<string | null>
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
    const share = await this.deps.shares.resolveLinkSecret(secret)
    if (!share) return null
    const [host, opensAs] = await Promise.all([this.hostOf(share), this.visitorOf(share, memberIn)])
    return { resource: share.resource, organizationId: share.organizationId, opensAs, host }
  }

  private async visitorOf(share: ResolvedLinkShare, memberIn: (organizationId: string) => Promise<Principal | null>): Promise<ShareLinkVisitor> {
    const member = await memberIn(share.organizationId)
    const role = member ? await this.deps.shares.roleFor(member, share.resource) : 'none'
    return resourceRoleAtLeast(role, share.role) ? { kind: 'member', role } : { kind: 'guest', role: share.role }
  }

  private async hostOf(share: ResolvedLinkShare): Promise<ShareLinkTarget['host']> {
    const hostId = share.resource.kind === 'session' ? await this.deps.runnerOf(share.organizationId, share.resource.id) : null
    if (!hostId) return null
    return { hostId, routes: this.deps.hostRoutes ? await this.deps.hostRoutes(hostId) : [] }
  }
}
