import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkReview, WorkReviewInboxItem, WorkReviewsChanged } from '@solus/contracts/work-review'
import type { ResourceRole, ShareResource } from '@solus/contracts/sharing'
import type { Principal } from '@solus/server/admission/principal'
import type { HandlerCtx, SolusServer } from '@solus/server/transport/server'
import { resetTestDatabase } from './helpers/test-db'

/**
 * Work review (docs/plans/work-review-and-live-editing.md, phase 2). A decision
 * names the exact body the reviewer saw; it goes stale when the body changes
 * and is current again when the body returns; the state is derived, never
 * stored; and the host, not the client, names the reviewer.
 */

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const ORGANIZATION = 'A'
const member = (userId: string, displayName: string): Principal => ({
  kind: 'org-member', userId, organizationId: ORGANIZATION, organizationRole: 'member', teamIds: [], hostKind: 'managed',
  displayName, deviceId: `${userId}-device`, expiresAt: Date.now() + 300_000, deviceLabel: 'Browser',
})
const ALICE = member('alice', 'Alice')
const BOB = member('bob', 'Bob Reviewer')
const CAROL = member('carol', 'Carol')
const GUEST: Principal = {
  kind: 'guest', organizationId: ORGANIZATION, guestId: 'g1', displayName: 'Maya (typed)', deviceId: 'g1', expiresAt: Date.now() + 300_000, deviceLabel: 'Guest link',
  share: { resource: { kind: 'work', id: 'unused' }, role: 'commenter', sharedByUserId: 'alice', linkSecretHash: 'h' },
}

let dataDir: string
const previousDataDir = process.env.SOLUS_DATA_DIR
let works: typeof import('@solus/server/data/works/works')
let workModule: typeof import('@solus/server/data/works/work')
let reviews: typeof import('@solus/server/data/works/work-reviews')
let actors: typeof import('@solus/server/admission/actor')
let access: typeof import('@solus/server/admission/access-policy')
const handlers = new Map<string, (args: unknown[], ctx: HandlerCtx) => unknown>()

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-work-reviews-'))
  process.env.SOLUS_DATA_DIR = dataDir
  works = await import('@solus/server/data/works/works')
  workModule = await import('@solus/server/data/works/work')
  reviews = await import('@solus/server/data/works/work-reviews')
  actors = await import('@solus/server/admission/actor')
  access = await import('@solus/server/admission/access-policy')
  const server = { register: (method: string, handler: (args: unknown[], ctx: HandlerCtx) => unknown) => handlers.set(method, handler) } as unknown as SolusServer
  ;(await import('@solus/server/transport/handlers/work-review-handlers')).registerWorkReviewHandlers(server)
})

afterEach(async () => {
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

function ctxOf(principal: Principal): HandlerCtx {
  return { clientId: `client-${principal.kind}`, principal, actor: actors.actorFor(principal) }
}

async function call<T>(method: string, principal: Principal, ...args: unknown[]): Promise<T> {
  return await handlers.get(method)!(args, ctxOf(principal)) as T
}

async function newWork(content = '# Spec\n\nFirst draft.') {
  return works.createWork(ORGANIZATION, 'Spec', 'doc', content, '', undefined, 'claude-code')
}

async function edit(workId: string, content: string) {
  const work = await workModule.Work.byId(ORGANIZATION, workId)
  return work.updateContent({ content, expectedContentVersion: work.contentVersion, author: null, reason: 'edit' })
}

function reviewerOf(review: WorkReview, reviewerId: string) {
  return review.reviewers.find((reviewer) => reviewer.reviewerId === reviewerId)!
}

describe('requesting a review', () => {
  test('a request points the reviewer at a fixed checkpoint and puts the work in their inbox', async () => {
    const work = await newWork()
    const review = await call<WorkReview>('workReviewRequest', ALICE, work.id, { reviewers: [{ userId: 'bob', displayName: 'Bob' }, { userId: 'carol', displayName: 'Carol' }], message: 'Please check the API section', expectedContentVersion: work.contentVersion })
    expect(review.state).toBe('in_review')
    const bob = reviewerOf(review, 'bob')
    expect(bob.isAwaiting).toBe(true)
    expect(bob.requestedBy?.displayName).toBe('Alice')
    // Both requests name one `review` checkpoint of the body Alice read.
    expect(reviewerOf(review, 'carol').requestedRevisionId).toBe(bob.requestedRevisionId)
    const revision = await (await workModule.Work.byId(ORGANIZATION, work.id)).revision(bob.requestedRevisionId!)
    expect(revision.reason).toBe('review')
    expect(revision.content).toBe(work.content)

    const inbox = await call<WorkReviewInboxItem[]>('workReviewInbox', BOB)
    expect(inbox.map((item) => item.workId)).toEqual([work.id])
    expect(inbox[0]!.requestMessage).toBe('Please check the API section')
    expect(await call<WorkReviewInboxItem[]>('workReviewInbox', ALICE)).toEqual([])
  })

  test('a request against a body the requester did not read is refused', async () => {
    const work = await newWork()
    await edit(work.id, 'changed')
    await expect(call('workReviewRequest', ALICE, work.id, { reviewers: [{ userId: 'bob', displayName: 'Bob' }], expectedContentVersion: work.contentVersion })).rejects.toMatchObject({ precondition: 'content' })
    expect((await call<WorkReview>('workReviewGet', ALICE, work.id)).state).toBe('draft')
  })
})

describe('decisions', () => {
  test('a decision is stale after an edit and current again when the edit is undone', async () => {
    // WHY: rule 2 — an approval applies to one body. Undoing an edit returns the
    // approved hash, so the approval counts again.
    const work = await newWork()
    await call('workReviewRequest', ALICE, work.id, { reviewers: [{ userId: 'bob', displayName: 'Bob' }], expectedContentVersion: work.contentVersion })
    let review = await call<WorkReview>('workReviewDecide', BOB, work.id, { target: { kind: 'current', contentVersion: work.contentVersion }, decision: 'approved', summary: 'Ship it' })
    expect(review.state).toBe('approved')
    expect(reviewerOf(review, 'bob').isAwaiting).toBe(false)
    expect(await call<WorkReviewInboxItem[]>('workReviewInbox', BOB)).toEqual([])

    await edit(work.id, '# Spec\n\nSecond draft.')
    review = await call<WorkReview>('workReviewGet', ALICE, work.id)
    expect(reviewerOf(review, 'bob').isStale).toBe(true)
    expect(review.state).toBe('in_review')

    await edit(work.id, work.content)
    review = await call<WorkReview>('workReviewGet', ALICE, work.id)
    expect(reviewerOf(review, 'bob').isStale).toBe(false)
    expect(review.state).toBe('approved')
  })

  test('a current request for changes outweighs an approval', async () => {
    const work = await newWork()
    const current = { kind: 'current', contentVersion: work.contentVersion }
    await call('workReviewDecide', BOB, work.id, { target: current, decision: 'approved' })
    const review = await call<WorkReview>('workReviewDecide', CAROL, work.id, { target: current, decision: 'changes_requested' })
    expect(review.state).toBe('changes_requested')
  })

  test('a decision on the current body the reviewer did not see is refused, never attached to the newer body', async () => {
    const work = await newWork()
    await edit(work.id, 'edited while Bob read')
    await expect(call('workReviewDecide', BOB, work.id, { target: { kind: 'current', contentVersion: work.contentVersion }, decision: 'approved' })).rejects.toMatchObject({ precondition: 'content' })
    // Bob can still decide on the checkpoint he was asked about; it is stale at once.
    const requested = await call<WorkReview>('workReviewRequest', ALICE, work.id, { reviewers: [{ userId: 'bob', displayName: 'Bob' }], expectedContentVersion: work.contentVersion + 1 })
    await edit(work.id, 'edited again')
    const review = await call<WorkReview>('workReviewDecide', BOB, work.id, { target: { kind: 'revision', revisionId: reviewerOf(requested, 'bob').requestedRevisionId }, decision: 'approved' })
    expect(reviewerOf(review, 'bob').isStale).toBe(true)
    expect(review.state).toBe('in_review')
  })

  test('the host names the reviewer from the principal, and the newest decision replaces the older one', async () => {
    const work = await newWork()
    await call('workReviewRequest', ALICE, work.id, { reviewers: [{ userId: 'bob', displayName: 'Directory Bob' }], expectedContentVersion: work.contentVersion })
    const current = { kind: 'current', contentVersion: work.contentVersion }
    await call('workReviewDecide', BOB, work.id, { target: current, decision: 'changes_requested' })
    const review = await call<WorkReview>('workReviewDecide', BOB, work.id, { target: current, decision: 'commented', summary: 'Fine now' })
    expect(review.reviewers).toHaveLength(1)
    expect(reviewerOf(review, 'bob')).toMatchObject({ displayName: 'Bob Reviewer', decision: 'commented', decisionSummary: 'Fine now' })
  })

  test('a person outside the organization reviews through a link, named from their guest grant', async () => {
    const work = await newWork()
    const review = await call<WorkReview>('workReviewDecide', GUEST, work.id, { target: { kind: 'current', contentVersion: work.contentVersion }, decision: 'approved' })
    expect(reviewerOf(review, 'guest:g1')).toMatchObject({ displayName: 'Maya (typed)', requestedBy: null, isAwaiting: false })
  })
})

describe('re-requesting and removing', () => {
  test('a re-request keeps the last decision, so the reviewer can see the changes since it', async () => {
    const work = await newWork()
    await call('workReviewRequest', ALICE, work.id, { reviewers: [{ userId: 'bob', displayName: 'Bob' }], expectedContentVersion: work.contentVersion })
    const decided = await call<WorkReview>('workReviewDecide', BOB, work.id, { target: { kind: 'current', contentVersion: work.contentVersion }, decision: 'changes_requested' })
    const decidedRevisionId = reviewerOf(decided, 'bob').decidedRevisionId
    const edited = await edit(work.id, '# Spec\n\nFixed.')
    const again = await call<WorkReview>('workReviewRequest', ALICE, work.id, { reviewers: [{ userId: 'bob', displayName: 'Bob' }], expectedContentVersion: edited.contentVersion })
    const bob = reviewerOf(again, 'bob')
    expect(bob).toMatchObject({ isAwaiting: true, isStale: true, decision: 'changes_requested', decidedRevisionId })
    expect(bob.requestedRevisionId).not.toBe(decidedRevisionId)
    const [item] = await call<WorkReviewInboxItem[]>('workReviewInbox', BOB)
    expect(item!.lastDecidedRevisionId).toBe(decidedRevisionId)
  })

  test('removing the last reviewer returns the work to draft', async () => {
    const work = await newWork()
    await call('workReviewRequest', ALICE, work.id, { reviewers: [{ userId: 'bob', displayName: 'Bob' }], expectedContentVersion: work.contentVersion })
    const review = await call<WorkReview>('workReviewRemove', ALICE, work.id, 'bob')
    expect(review).toMatchObject({ state: 'draft', reviewers: [] })
    expect(await call<WorkReviewInboxItem[]>('workReviewInbox', BOB)).toEqual([])
  })

  test('each change is announced once, after it commits', async () => {
    const work = await newWork()
    const changes: WorkReviewsChanged[] = []
    const stop = reviews.onWorkReviewsChanged((change) => changes.push(change))
    try {
      await call('workReviewRequest', ALICE, work.id, { reviewers: [{ userId: 'bob', displayName: 'Bob' }], expectedContentVersion: work.contentVersion })
      await expect(call('workReviewRequest', ALICE, work.id, { reviewers: [{ userId: 'carol', displayName: 'Carol' }], expectedContentVersion: 99 })).rejects.toThrow()
      await call('workReviewDecide', BOB, work.id, { target: { kind: 'current', contentVersion: work.contentVersion }, decision: 'approved' })
    } finally {
      stop()
    }
    expect(changes.map((change) => [change.change, change.reviewerIds])).toEqual([['requested', ['bob']], ['decided', ['bob']]])
    expect(changes[1]!.by?.displayName).toBe('Bob Reviewer')
  })
})

describe('access for reviewers', () => {
  test('a member asked to review who cannot open the work is given it as a commenter; a refused request gives nobody access', async () => {
    const { ShareManager } = await import('@solus/server/sharing/share-manager')
    const { getDatabase } = await import('@solus/server/db/database')
    const shares = new ShareManager({ db: getDatabase(), organizationOfResource: async () => ORGANIZATION })
    const withShares = new Map<string, (args: unknown[], ctx: HandlerCtx) => unknown>()
    const server = { register: (method: string, handler: (args: unknown[], ctx: HandlerCtx) => unknown) => withShares.set(method, handler) } as unknown as SolusServer
    ;(await import('@solus/server/transport/handlers/work-review-handlers')).registerWorkReviewHandlers(server, { shares })
    const work = await newWork()
    const resource = { kind: 'work', id: work.id } as const
    await shares.claimOwner(resource, ALICE)
    // Private to Alice: a managed host shares a new work with its organization.
    await shares.setGrants({ resource, grants: [] }, ALICE)

    await expect(withShares.get('workReviewRequest')!([work.id, { reviewers: [{ userId: 'carol', displayName: 'Carol' }], expectedContentVersion: 99 }], ctxOf(ALICE))).rejects.toThrow()
    expect((await shares.list(resource, ALICE)).grants).toEqual([])

    await withShares.get('workReviewRequest')!([work.id, { reviewers: [{ userId: 'bob', displayName: 'Bob' }], expectedContentVersion: work.contentVersion }], ctxOf(ALICE))
    expect((await shares.list(resource, ALICE)).grants.map((grant) => [grant.subject.id, grant.role])).toEqual([['bob', 'commenter']])
    expect(await shares.roleFor(BOB, resource)).toBe('commenter')
  })
})

describe('roles', () => {
  const resources = (role: ResourceRole) => ({ roleFor: async (_principal: Principal, _resource: ShareResource) => role })

  test('a commenter comments and decides but cannot edit or request; a viewer only reads', async () => {
    const call = (method: Parameters<typeof access.assertRpcAccess>[0], role: ResourceRole) => access.assertRpcAccess(method, BOB, ['w1', {}], resources(role), false)
    await expect(call('applyWorkComment', 'commenter')).resolves.toBeUndefined()
    await expect(call('workReviewDecide', 'commenter')).resolves.toBeUndefined()
    await expect(call('workReviewGet', 'viewer')).resolves.toBeUndefined()
    await expect(call('applyWorkComment', 'viewer')).rejects.toThrow()
    await expect(call('workReviewDecide', 'viewer')).rejects.toThrow()
    await expect(call('workReviewRequest', 'commenter')).rejects.toThrow()
    await expect(call('restoreWorkRevision', 'commenter')).rejects.toThrow()
    await expect(call('workReviewRequest', 'editor')).resolves.toBeUndefined()
  })
})
