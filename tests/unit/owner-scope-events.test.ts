import { afterEach, expect, test } from 'bun:test'
import type { HostEvent } from '@solus/contracts/host-events'
import type { Principal } from '@solus/server/admission/principal'
import { readsWholeDisk } from '@solus/server/admission/principal'
import { useOrganizationAttachment } from '@solus/server/host/organization-attachment'
import { applyHostCategory, resetHostCategoryForTests } from '@solus/server/host/host-category'
import { eventVisibleTo } from '@solus/server/sharing/event-audience'
import { presenceAccessFor } from '@solus/server/presence/presence-manager'
import type { ShareManager } from '@solus/server/sharing/share-manager'

// plans/031 item 9: on a machine attached for organization work, a pairing reads Local
// records only, yet it heard every organization session's events and presence.

const PAIRED: Principal = { kind: 'owner', via: 'local', expiresAt: null, deviceId: 'phone', deviceLabel: 'Phone' }
const event = (sessionId: string): HostEvent => ({ type: 'session.titleChanged', payload: { sessionId, title: 'x' }, occurredAt: 1 } as HostEvent)
// The share manager answers as `standingOf` would for a Local-scoped owner.
const shares = { roleFor: async (_principal: Principal, resource: { id: string }) => resource.id === 'org-session' ? 'none' : 'owner' } as unknown as ShareManager

afterEach(() => {
  useOrganizationAttachment(() => null)
  resetHostCategoryForTests()
})

test('an attached machine\'s pairing hears only what it may read; unattached, the owner hears everything', async () => {
  // A standalone server its owner attached to an organization.
  applyHostCategory('self-hosted')
  useOrganizationAttachment(() => 1_000)
  expect(readsWholeDisk(PAIRED)).toBe(false)
  expect(await eventVisibleTo(PAIRED, event('org-session'), shares)).toBe(false)
  expect(await eventVisibleTo(PAIRED, event('local-session'), shares)).toBe(true)
  expect(presenceAccessFor(PAIRED)).toBe('member')

  useOrganizationAttachment(() => null)
  expect(readsWholeDisk(PAIRED)).toBe(true)
  expect(await eventVisibleTo(PAIRED, event('org-session'), shares)).toBe(true)
  expect(presenceAccessFor(PAIRED)).toBe('owner')
})
