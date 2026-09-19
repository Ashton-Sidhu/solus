import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { asHostApi } from '@solus/client-core/host-api'
import type { IpcContext } from '@solus/contracts/types'
import { projectScopeOf } from '@solus/contracts/types'
import type { TaskLink, TaskSidebarPrLink } from '@solus/contracts/task-types'
import { linkedPrIdentity } from '@solus/workspace-ui/contexts/prs/linked-pr'
import { taskPrRows } from '@solus/workspace-ui/components/tasks/task-page/lib/task-prs'
import { previewPrRows } from '@solus/workspace-ui/components/session/lib/task-preview.svelte'
import { prChipForChoices } from '@solus/workspace-ui/components/session/lib/task-list'
import { pullRequestFixture } from './__fixtures__/pull-request'

const previousState = Object.getOwnPropertyDescriptor(globalThis, '$state')
beforeEach(() => {
  Object.defineProperty(globalThis, '$state', {
    configurable: true,
    value: Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => value }),
  })
})
afterEach(() => {
  if (previousState) Object.defineProperty(globalThis, '$state', previousState)
  else Reflect.deleteProperty(globalThis, '$state')
})

function ctx(projectPath: string): IpcContext {
  return { session: { projectPath, workingDirectory: projectPath }, settings: {}, statusBar: {} } as IpcContext
}

function link(repo: string): TaskLink {
  return {
    taskId: 'task', kind: 'pr', targetScope: '/old-project', targetKey: '42',
    title: '#42', url: `https://github.com/acme/${repo}/pull/42`, createdBy: 'user', linkedAt: 1,
  }
}

describe('linked PR ownership', () => {
  test('URL identity wins; number-only legacy links retain their host-resolved scope', () => {
    expect(linkedPrIdentity({ ...link('other'), targetKey: '7' }, '/active')).toMatchObject({
      number: 42, targetScope: 'github.com/acme/other',
    })
    expect(linkedPrIdentity({ number: 7, targetScope: '/legacy' }, '/active')?.targetScope).toBe('/legacy')
    expect(linkedPrIdentity({ number: 7 }, '/active')?.targetScope).toBe('/active')
    expect(linkedPrIdentity({ number: 0 }, '/active')).toBeNull()
    expect(linkedPrIdentity({ ...link('other'), kind: 'work' }, '/active')).toBeNull()
  })

  test('all surfaces share status across repositories, active project changes and duplicate subscriptions', async () => {
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore(async () => {}, () => () => {})
    const calls: string[] = []
    const api = asHostApi({
      prList: async (context) => {
        calls.push(projectScopeOf(context.session))
        expect(context.session.gitContext).toBeNull()
        return { items: [], page: 1, hasMore: true }
      },
      prGetDetail: async (context, number) => {
        const scope = projectScopeOf(context.session)
        calls.push(`${scope}#${number}`)
        return pullRequestFixture(number, {
          state: scope.endsWith('/first') ? 'merged' : 'open',
          title: scope,
        })
      },
    })
    const links = [link('first'), link('second')]
    const releases = [
      store.watchLinkedPrs(api, 'host-a', ctx('/solus'), links),
      store.watchLinkedPrs(api, 'host-a', ctx('/different-active-project'), links),
    ]
    try {
      await Promise.all(['first', 'second'].map((repo) => {
        const done = Promise.withResolvers<void>()
        releases.push(store.watch(store.at('host-a', `github.com/acme/${repo}`)!, {}, done.resolve))
        return done.promise
      }))
      expect(calls.sort()).toEqual([
        'github.com/acme/first', 'github.com/acme/first#42',
        'github.com/acme/second', 'github.com/acme/second#42',
      ])
      const read = (value: TaskLink | TaskSidebarPrLink) => store.linkedPr('host-a', value, '/now-another-project')
      expect(taskPrRows(links, read).map((row) => row.state?.state)).toEqual(['merged', 'open'])
      expect(previewPrRows(links, null, read).map((row) => row.state?.state)).toEqual(['merged', 'open'])
      expect(prChipForChoices(links.map((value) => read(value)!))?.state).toBe('open')
      expect(store.linkedPr('host-b', links[0], '/solus')?.pullRequest).toBeNull()
      store.at('host-a', 'github.com/acme/second')!.applyPullRequest(pullRequestFixture(42, { state: 'merged' }))
      expect(prChipForChoices(links.map((value) => read(value)!))?.state).toBe('merged')
      expect(taskPrRows(links, read).every((row) => row.state?.state === 'merged')).toBe(true)
      expect(previewPrRows(links, null, read).every((row) => row.state?.state === 'merged')).toBe(true)
    } finally { releases.forEach((release) => release()) }
  })

  test('saved observations are shared, do not regress, and survive failed refresh', async () => {
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    // Keep background work parked; explicitly exercise the refresh below.
    const start = Promise.withResolvers<void>()
    const store = new PrsStore(() => start.promise, () => () => {})
    const snapshot = pullRequestFixture(42, { state: 'merged', updatedAt: '2026-09-18T00:00:00Z' })
    const saved = { number: 42, url: link('first').url, snapshot }
    const api = asHostApi({ prList: async () => { throw new Error('offline') } })
    const release = store.watchLinkedPrs(api, 'host-a', ctx('/active'), [saved])
    try {
      const project = store.at('host-a', 'github.com/acme/first')!
      project.absorb(pullRequestFixture(42, { state: 'open' }))
      expect(store.linkedPr('host-a', link('first'), '/active')?.pullRequest?.state).toBe('merged')
      project.forgetAll()
      await project.refreshObserved([], [], [], [42])
      expect(store.linkedPr('host-a', link('first'), '/active')?.pullRequest?.state).toBe('merged')
      project.absorb(pullRequestFixture(42, { title: 'New title', state: 'merged', updatedAt: '2026-09-19T00:00:00Z' }))
      expect(store.linkedPr('host-a', saved, '/active')?.title).toBe('New title')
    } finally { release(); start.resolve() }
  })

  test('an unreadable link stays present with unknown status', async () => {
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()
    const result = store.linkedPr('host-a', link('first'), '/active')!
    expect(result.number).toBe(42)
    expect(result.pullRequest).toBeNull()
    expect(prChipForChoices([result])?.state).toBe('unknown')
  })

  test('closing the last linked surface cancels work that has not started', async () => {
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const start = Promise.withResolvers<void>()
    const store = new PrsStore(() => start.promise, () => () => {})
    let reads = 0
    const api = asHostApi({ prList: async () => {
      reads++
      return { items: [], page: 1, hasMore: false }
    } })
    const release = store.watchLinkedPrs(api, 'host-a', ctx('/active'), [link('first')])
    release()
    // A second active observer gives a deterministic end-of-drain signal.
    const settled = Promise.withResolvers<void>()
    const other = store.get(asHostApi({ prList: async () => ({ items: [], page: 1, hasMore: false }) }), 'host-a', ctx('/other'))
    const stop = store.watch(other, { numbers: [1] }, settled.resolve)
    try {
      start.resolve()
      await settled.promise
      expect(reads).toBe(0)
    } finally { stop() }
  })
})
