import { describe, expect, test } from 'bun:test'
import type { ResourceRole } from '@solus/contracts/sharing'
import type { SolusServerTarget } from '@solus/client-core/server-connection'
import { memberLinkFor, type GuestMemberDeps } from '../../apps/client/src/lib/guest-member'

// A guest link opened by a signed-in member of the resource's organization
// (docs/plans/cloud-sharing.md §4a). The member must keep their own role; the
// guest page gives only the link's role.

const workspace: SolusServerTarget = { id: 'solus-api:org1', label: 'Acme', url: 'wss://t.example', sessionToken: '', local: false }
const member = { userId: 'bob', organizationId: 'org1' }
const share = { resource: { kind: 'work' as const, id: 'w1' }, role: 'viewer' as const }

function deps(member: SolusServerTarget | null, role: ResourceRole | null): GuestMemberDeps {
  return { memberTarget: async () => member, callerRole: async () => role }
}

describe('a signed-in visitor on a guest link', () => {
  test('a member with a higher role than the link opens it as themselves', async () => {
    // WHY: an editor through the organization who opens a "can view" link must
    // not be reduced to a guest viewer.
    const link = await memberLinkFor(share, member, 'https://app.solus.sh', deps(workspace, 'editor'))
    expect(link?.startsWith('https://app.solus.sh/work/')).toBe(true)
    expect(link).toContain('w1')
  })

  test('a member with the same role also opens it as themselves', async () => {
    expect(await memberLinkFor(share, member, 'https://app.solus.sh', deps(workspace, 'viewer'))).not.toBeNull()
  })

  test('the guest page stays when the link gives more, or the visitor is not a member', async () => {
    // WHY: leaving the guest page must never lower what the visitor can do.
    expect(await memberLinkFor({ ...share, role: 'editor' }, member, 'https://app.solus.sh', deps(workspace, 'viewer'))).toBeNull()
    expect(await memberLinkFor(share, member, 'https://app.solus.sh', deps(workspace, 'none'))).toBeNull()
    expect(await memberLinkFor(share, member, 'https://app.solus.sh', deps(workspace, null))).toBeNull()
    expect(await memberLinkFor(share, member, 'https://app.solus.sh', deps(null, 'owner'))).toBeNull()
    // An anonymous guest is never checked.
    expect(await memberLinkFor(share, { organizationId: 'org1' }, 'https://app.solus.sh', deps(workspace, 'owner'))).toBeNull()
  })
})
