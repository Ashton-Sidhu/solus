import { afterEach, expect, test } from 'bun:test'
import type { HostEvent } from '@solus/contracts/host-events'
import type { Principal } from '@solus/server/admission/principal'
import { readsWholeDisk } from '@solus/server/admission/principal'
import { adoptRegistration, resetMachineKindForTests } from '@solus/server/host/machine-kind'
import { eventVisibleTo } from '@solus/server/sharing/event-audience'
import { presenceAccessFor } from '@solus/server/presence/presence-manager'
import type { ShareManager } from '@solus/server/sharing/share-manager'

// plans/031 item 9, plans/034 §2: a cloud machine is nobody's machine. A connection
// with no credential reads Local records only, so it must not hear an organization
// session's events and presence either.

const PAIRED: Principal = { kind: 'owner', via: 'local', expiresAt: null, deviceId: 'phone', deviceLabel: 'Phone' }
const event = (sessionId: string): HostEvent => ({ type: 'session.titleChanged', payload: { sessionId, title: 'x' }, occurredAt: 1 } as HostEvent)
// The share manager answers as `standingOf` would for a Local-scoped owner.
const shares = { roleFor: async (_principal: Principal, resource: { id: string }) => resource.id === 'org-session' ? 'none' : 'owner' } as unknown as ShareManager

afterEach(() => {
  resetMachineKindForTests()
})

test('a local connection on a cloud machine hears only what it may read; on a personal machine, the owner hears everything', async () => {
  // A standalone server that registered with an organization code.
  adoptRegistration({ organizationId: 'org_1' })
  expect(readsWholeDisk(PAIRED)).toBe(false)
  expect(await eventVisibleTo(PAIRED, event('org-session'), shares)).toBe(false)
  expect(await eventVisibleTo(PAIRED, event('local-session'), shares)).toBe(true)
  expect(presenceAccessFor(PAIRED)).toBe('member')

  // A personal machine, also one that is shared with an organization: nothing but the registration changes this.
  // (Another process: a cloud machine never becomes a personal one.)
  resetMachineKindForTests()
  adoptRegistration({})
  expect(readsWholeDisk(PAIRED)).toBe(true)
  expect(await eventVisibleTo(PAIRED, event('org-session'), shares)).toBe(true)
  expect(presenceAccessFor(PAIRED)).toBe('owner')
})
