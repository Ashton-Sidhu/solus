import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { PrInterest, PrSyncChange } from '@solus/contracts/providers'
import type { IpcContext } from '@solus/contracts/types'
import { pullRequestFixture } from './__fixtures__/pull-request'
import { singleHostServerConnections } from './helpers/server-connections-mock'
import { readFirstPage } from './__fixtures__/pr-listing'

/**
 * The client half of PR sync (docs/plans/pr-sync.md). Surfaces declare
 * interest; the host keeps it fresh and pushes `pr.changed`. Nothing on the
 * client polls, so these tests pin what is sent and what a push changes.
 */

const serverConnectionsMock = singleHostServerConnections()
mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: serverConnectionsMock,
}))

const previousState = (globalThis as unknown as { $state?: unknown }).$state

beforeEach(() => {
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
    <T>(value: T) => value,
    { snapshot: <T>(value: T) => value },
  )
})

afterEach(() => {
  serverConnectionsMock.reset()
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

const REPO = 'github.com/acme/repo'
const ctx = {
  session: { projectPath: '/repo', workingDirectory: '/repo' },
  window: {},
  settings: {},
  statusBar: {},
} as IpcContext

const emptyChange = (overrides: Partial<PrSyncChange> = {}): PrSyncChange => ({
  repo: REPO, pullRequests: [], missing: [], checks: [], ...overrides,
})

/** A host that lists one pull request and records every interest it is sent. */
function host(serverId: string) {
  const sent: PrInterest[][] = []
  serverConnectionsMock.registerHost(serverId, {
    prList: async () => ({ items: [pullRequestFixture(33)], page: 1, hasMore: false }),
    prListProjects: async (_ctx: IpcContext, roots: string[]) =>
      roots.map((projectRoot) => ({ projectRoot, page: { items: [pullRequestFixture(33)], page: 1, hasMore: false } })),
    prSetInterest: async (_ctx: IpcContext, interests: PrInterest[]) => {
      sent.push(interests)
      return emptyChange()
    },
  })
  return { api: serverConnectionsMock.apiFor(serverId), sent }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

async function newStore() {
  const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
  return new PrsStore(() => Promise.resolve())
}

describe('interest', () => {
  test('closing a surface during registration still clears its interest after the answer', async () => {
    const { api } = host('host-a')
    const sent: PrInterest[][] = []
    let finish!: (change: PrSyncChange) => void
    let started!: () => void
    const registering = new Promise<void>((resolve) => { started = resolve })
    let cleared!: () => void
    const clearing = new Promise<void>((resolve) => { cleared = resolve })
    api.prSetInterest = async (_ctx, interests) => {
      sent.push(interests)
      if (interests.length) {
        started()
        return new Promise<PrSyncChange>((resolve) => { finish = resolve })
      }
      cleared()
      return emptyChange()
    }
    const store = await newStore()
    const release = store.want(api, 'host-a', ctx, [{ kind: 'needs-review' }])
    await registering
    release()
    finish(emptyChange())
    await clearing
    expect(sent).toEqual([[{ kind: 'needs-review' }], []])
  })

  test('repeated surface registration sends nothing until the combined interest changes', async () => {
    const { api, sent } = host('host-a')
    const store = await newStore()
    const release = store.want(api, 'host-a', ctx, [{ kind: 'needs-review' }])
    await settle()
    const releaseSecond = store.want(api, 'host-a', ctx, [{ kind: 'needs-review' }])
    await settle()
    release()
    await settle()
    expect(sent).toEqual([[{ kind: 'needs-review' }]])
    releaseSecond()
    // A reactive surface reattaching within one task leaves the interest unchanged.
    const releaseReplacement = store.want(api, 'host-a', ctx, [{ kind: 'needs-review' }])
    await settle()
    expect(sent).toHaveLength(1)
    releaseReplacement()
    await settle()
    expect(sent).toEqual([[{ kind: 'needs-review' }], []])
  })

  test('surfaces of one project cost one request, and releasing the last sends an empty set', async () => {
    const { api, sent } = host('host-a')
    const store = await newStore()

    const releaseRow = store.want(api, 'host-a', ctx, [{ kind: 'pull-request', number: 1 }])
    const releaseRail = store.want(api, 'host-a', ctx, [{ kind: 'branch', head: 'topic' }, { kind: 'pull-request', number: 1 }])
    await settle()
    expect(sent).toEqual([[{ kind: 'pull-request', number: 1 }, { kind: 'branch', head: 'topic' }]])

    releaseRow()
    releaseRail()
    await settle()
    expect(sent.at(-1)).toEqual([])
    expect(sent).toHaveLength(2)
  })

  test('a reconnect sends the interest again, because the host dropped it', async () => {
    const { api, sent } = host('host-a')
    const store = await newStore()
    const release = store.want(api, 'host-a', ctx, [{ kind: 'needs-review' }])
    await settle()

    serverConnectionsMock.emitStatus('host-a', 'connected')
    await settle()

    expect(sent).toHaveLength(2)
    release()
  })
})

describe('pr.changed', () => {
  test('reaches only the projects on that host that read its repository', async () => {
    const a = host('host-a')
    const b = host('host-b')
    const store = await newStore()
    const projectA = store.get(a.api, 'host-a', ctx)
    const projectB = store.get(b.api, 'host-b', ctx)
    await readFirstPage(store, projectA)
    await readFirstPage(store, projectB)
    const release = store.want(a.api, 'host-a', ctx, [{ kind: 'repository' }])
    await settle()

    serverConnectionsMock.emit('host-a', 'pr.changed', emptyChange({
      pullRequests: [pullRequestFixture(33, { title: 'Renamed on GitHub', updatedAt: '2026-02-01T00:00:00Z' })],
    }))

    expect(projectA.prFor(33)?.title).toBe('Renamed on GitHub')
    expect(projectB.prFor(33)?.title).toBe('PR 33')
    release()
  })

  test('a new pull request joins the list it belongs on, and an older answer is ignored', async () => {
    const { api } = host('host-a')
    const store = await newStore()
    const project = store.get(api, 'host-a', ctx)
    await readFirstPage(store, project)
    const release = store.want(api, 'host-a', ctx, [{ kind: 'repository' }])
    await settle()

    serverConnectionsMock.emit('host-a', 'pr.changed', emptyChange({
      pullRequests: [
        pullRequestFixture(34, { title: 'Opened elsewhere', updatedAt: '2026-02-01T00:00:00Z' }),
        pullRequestFixture(33, { title: 'Stale', updatedAt: '2025-12-01T00:00:00Z' }),
      ],
    }))

    expect(project.items.map((item) => item.number)).toEqual([34, 33])
    expect(project.prFor(33)?.title).toBe('PR 33')
    release()
  })

  test('needs-review numbers and check runs reach their stores', async () => {
    const { api } = host('host-a')
    const store = await newStore()
    const { PrNeedsReviewStore } = await import('@solus/workspace-ui/contexts/prs/pr-needs-review.store.svelte')
    const { PrChecksStore } = await import('@solus/workspace-ui/contexts/prs/pr-checks.store.svelte')
    const needsReview = new PrNeedsReviewStore(store)
    const checks = new PrChecksStore(store)
    const project = store.get(api, 'host-a', ctx)
    await readFirstPage(store, project)
    const release = store.want(api, 'host-a', ctx, [{ kind: 'needs-review' }, { kind: 'review', number: 33 }])
    await settle()

    const summary = { state: 'failing', inFlight: false, total: 1, passed: 0, failed: 1, pending: 0, runs: [] }
    serverConnectionsMock.emit('host-a', 'pr.changed', emptyChange({
      needsReview: [33],
      // SAFETY: the summary's shape is the checks contract; only its identity is asserted.
      checks: [{ number: 33, summary } as unknown as PrSyncChange['checks'][number]],
    }))

    expect(needsReview.countFor('host-a', ctx)).toBe(1)
    expect(checks.summaryFor('host-a', ctx, 33)).toBe(summary as never)
    release()
  })

  test('a sidebar row reads the checks of its repository only', async () => {
    // WHY: a sidebar row has a pull request, not a host context. It must find
    // the checks the PR surfaces read, and the same number in another
    // repository must not borrow them.
    const { api } = host('host-a')
    const store = await newStore()
    const { PrChecksStore } = await import('@solus/workspace-ui/contexts/prs/pr-checks.store.svelte')
    const checks = new PrChecksStore(store)
    const project = store.get(api, 'host-a', ctx)
    await readFirstPage(store, project)
    const release = store.want(api, 'host-a', ctx, [{ kind: 'review', number: 33 }])
    await settle()

    const summary = { state: 'failing', required: [], optional: [], headSha: 'head-33', inFlight: false }
    serverConnectionsMock.emit('host-a', 'pr.changed', emptyChange({ checks: [{ number: 33, summary } as never] }))

    expect(checks.summaryIn('host-a', REPO, 33)).toBe(summary as never)
    expect(checks.summaryIn('host-a', 'github.com/acme/other', 33)).toBeUndefined()
    release()
  })
})

describe('linked pull requests', () => {
  test('a URL-named link reads the live state of the project it was found in', async () => {
    // WHY: a link names its repository (`github.com/acme/repo`), but a project
    // files its pull requests under its local path. The sidebar chip must take
    // its colour from the live record there, not from an old snapshot or from
    // nothing — a merged pull request must not stay green.
    const { api } = host('host-a')
    const store = await newStore()
    const project = store.get(api, 'host-a', ctx)
    await readFirstPage(store, project)
    const release = store.want(api, 'host-a', ctx, [{ kind: 'repository' }])
    await settle()
    serverConnectionsMock.emit('host-a', 'pr.changed', emptyChange({
      pullRequests: [pullRequestFixture(33, { state: 'merged', updatedAt: '2026-02-01T00:00:00Z' })],
    }))
    const url = 'https://github.com/acme/repo/pull/33'
    const snapshot = { ...pullRequestFixture(33), state: 'open' as const }

    expect(store.linkedPr('host-a', { number: 33, url }, '/repo')?.pullRequest?.state).toBe('merged')
    expect(store.linkedPr('host-a', { number: 33, url, snapshot }, '/repo')?.pullRequest?.state).toBe('merged')
    // The same number in another repository is another pull request.
    expect(store.linkedPr('host-a', { number: 33, url: 'https://github.com/acme/other/pull/33' }, '/repo')?.pullRequest).toBeNull()
    release()
  })
})
