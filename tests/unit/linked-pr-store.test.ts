import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { asHostApi } from '@solus/client-core/host-api'
import type { IpcContext } from '@solus/contracts/types'
import { projectScopeOf } from '@solus/contracts/types'
import type { TaskLink } from '@solus/contracts/task-types'
import { linkedPrIdentity } from '@solus/workspace-ui/contexts/prs/linked-pr'
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
    title: '#42', url: `https://github.com/acme/${repo}/pull/42`, createdBy: { kind: 'user', user: { id: { kind: 'account', accountId: 'u1' }, displayName: 'U One' } }, linkedAt: 1,
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

  test('links ask PR sync for their pull requests, one request per repository', async () => {
    // WHY: a task page names pull requests in several repositories. Each
    // repository is its own interest set, and closing the page stops them all.
    const sent: Array<{ scope: string; interests: unknown[] }> = []
    const api = asHostApi({
      prSetInterest: async (context: IpcContext, interests: unknown[]) => {
        sent.push({ scope: projectScopeOf(context.session), interests })
        return { repo: 'github.com/acme/x', pullRequests: [pullRequestFixture(42)], missing: [], checks: [] }
      },
    })
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore(() => Promise.resolve())

    const release = store.wantLinkedPrs(api, 'host-a', ctx('/active'), [link('first'), link('second')])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sent.map(({ scope }) => scope).toSorted()).toEqual(['github.com/acme/first', 'github.com/acme/second'])
    expect(sent.every(({ interests }) => JSON.stringify(interests) === '[{"kind":"pull-request","number":42}]')).toBe(true)

    release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sent.slice(2).map(({ interests }) => interests)).toEqual([[], []])
  })

  test('a link the code host says does not exist reads as not found, not as unknown', async () => {
    // WHY: PR sync stops asking about a missing pull request. The row must say
    // so, so the user can remove the link, rather than wait for a state forever.
    const { taskPrRows } = await import('@solus/workspace-ui/components/tasks/task-page/lib/task-prs')
    const missing = { ...link('gone'), missing: true }
    const rows = taskPrRows([missing], (row) => ({ ...linkedPrIdentity(row, '/active')!, pullRequest: null, missing: row.missing === true }))
    expect(rows[0]).toMatchObject({ number: 42, missing: true, state: null })
  })
})
