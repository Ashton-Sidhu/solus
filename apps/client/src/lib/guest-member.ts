import { resourceRoleAtLeast, type ResourceRole, type ShareResource } from '@solus/contracts/sharing'
import { solusApiId } from '@solus/contracts/uplink'
import { createSolusConnection, type SolusServerTarget } from '@solus/client-core/server-connection'
import { adoptCloudOriginIfPresent } from '@solus/client-core/uplink-account'
import { saveDirectoryWorkspaces, savedWorkspaceFor, workspaceTarget } from '@solus/client-core/workspace-registry'
import { appLinkUrl } from '@solus/workspace-ui/contexts/sharing/app-link'
import type { GuestShare } from './guest-boot.svelte'

/** How long the member check may hold the guest page before it opens as a guest. */
const MEMBER_CHECK_TIMEOUT_MS = 8_000

export interface GuestMemberDeps {
  /** The account's organization workspace services, or null when not signed in here. */
  memberTarget(origin: string, organizationId: string): Promise<SolusServerTarget | null>
  /** The account's own role on the resource through its membership; null when it has none or the service did not answer. */
  callerRole(target: SolusServerTarget, resource: ShareResource): Promise<ResourceRole | null>
}

/**
 * A guest link opened by someone who is already a member with at least the
 * link's role: the address that opens the resource as that member, so they keep
 * their own role and the whole app. Null keeps the guest page: not a member of
 * the resource's organization, a lower role than the link gives, or no answer.
 */
export async function memberLinkFor(
  share: GuestShare,
  visitor: { userId?: string; organizationId?: string },
  origin: string,
  deps: GuestMemberDeps = defaultDeps,
): Promise<string | null> {
  // An anonymous guest has no membership to check.
  if (!visitor.userId || !visitor.organizationId) return null
  const target = await deps.memberTarget(origin, visitor.organizationId)
  if (!target) return null
  const role = await deps.callerRole(target, share.resource)
  return role && resourceRoleAtLeast(role, share.role) ? appLinkUrl(origin, share.resource, target.id) : null
}

const defaultDeps: GuestMemberDeps = {
  async memberTarget(origin, organizationId) {
    // Also configures the account source the member connection mints its grant from.
    const probe = await adoptCloudOriginIfPresent(origin)
    if (probe.kind !== 'signed-in' || !probe.directory) return null
    saveDirectoryWorkspaces(probe.directory.workspaces, probe.directory.directoryUrl)
    const workspace = savedWorkspaceFor(solusApiId(organizationId))
    return workspace ? workspaceTarget(workspace) : null
  },
  async callerRole(target, resource) {
    const { transport, api } = createSolusConnection(target)
    transport.start()
    try {
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), MEMBER_CHECK_TIMEOUT_MS))
      const list = await Promise.race([api.shareGet({ resource }), timeout])
      return list?.callerRole ?? null
    } catch {
      return null
    } finally {
      transport.destroy()
    }
  },
}
