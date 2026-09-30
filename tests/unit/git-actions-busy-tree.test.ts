import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import type { GitActionRequest, GitActionResult } from '@solus/contracts/types'
import { WORKING_TREE_BUSY_CODE } from '@solus/contracts/types'
import { HostRpcError } from '@solus/client-core/rpc-error'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const progress = { update() {}, success() {}, info() {}, error() {}, dismiss() {} }
mock.module('@solus/workspace-ui/lib/toasts', () => ({
  toasts: { progress: () => progress, error: () => {}, info: () => {}, success: () => {}, warning: () => {} },
}))
mock.module('@solus/workspace-ui/lib/inputFocus', () => ({
  FOCUS_INPUT_EVENT: 'solus:focus-input',
  requestInputFocus: () => {},
  blurActiveTextInputOnMobile: () => {},
}))
mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: singleHostServerConnections(),
}))

const testGlobal = globalThis as unknown as { $state?: unknown }
const previousState = testGlobal.$state

beforeAll(() => {
  testGlobal.$state = Object.assign(<T>(value: T): T => value, { snapshot: <T>(value: T): T => value })
})

afterAll(() => {
  if (previousState === undefined) delete testGlobal.$state
  else testGlobal.$state = previousState
})

const committed = { commit: { status: 'created', subject: 'Change' }, push: { status: 'skipped' }, pullRequest: { status: 'skipped' } } as GitActionResult

/** A host that answers "busy" until the request says the person continued (plan 004 item 7). */
async function actionsOnBusyTree() {
  const { GitActions } = await import('@solus/workspace-ui/lib/git-actions.svelte')
  const requests: GitActionRequest[] = []
  const session = {
    runFor: () => null,
    ctxForEnvironment: () => ({ session: { workingDirectory: '/repo' } }),
    apiFor: () => ({
      gitRunAction: async (_ctx: unknown, request: GitActionRequest) => {
        requests.push(request)
        if (!request.allowBusyWorkingTree) throw new HostRpcError('Alice has a session running in this working tree.', WORKING_TREE_BUSY_CODE)
        return committed
      },
    }),
    serverIdFor: () => 'host-a',
  }
  const environmentStore = {
    environmentFor: () => ({ cwd: '/repo', checkout: { branch: 'main', targetBranch: 'main' } }),
    refreshEnvironment: async () => null,
    statusFor: () => null,
  }
  const actions = new GitActions(
    session as unknown as ConstructorParameters<typeof GitActions>[0],
    'tab-1',
    environmentStore as unknown as ConstructorParameters<typeof GitActions>[2],
    { get: () => ({ prForBranch: () => null, absorbCreated: () => {} }) } as unknown as ConstructorParameters<typeof GitActions>[3],
  )
  return { actions, requests }
}

async function questionAsked(): Promise<string> {
  const { busyTreeQuestion } = await import('@solus/workspace-ui/contexts/git/busy-tree.store.svelte')
  for (let i = 0; i < 50 && busyTreeQuestion.message === null; i++) await new Promise((resolve) => setTimeout(resolve, 1))
  return busyTreeQuestion.message ?? ''
}

describe('a git action in a busy working tree', () => {
  test('asks the person, and runs again only when they continue', async () => {
    const { busyTreeQuestion } = await import('@solus/workspace-ui/contexts/git/busy-tree.store.svelte')
    const { actions, requests } = await actionsOnBusyTree()
    const running = actions.run('commit')
    expect(await questionAsked()).toBe('Alice has a session running in this working tree.')
    busyTreeQuestion.settle(true)
    await running
    expect(requests.map((request) => request.allowBusyWorkingTree ?? false)).toEqual([false, true])
    expect(actions.lastResult).toEqual(committed)
    expect(actions.actionError).toBeNull()
  })

  test('does nothing more when the person cancels', async () => {
    const { busyTreeQuestion } = await import('@solus/workspace-ui/contexts/git/busy-tree.store.svelte')
    const { actions, requests } = await actionsOnBusyTree()
    const running = actions.run('commit')
    await questionAsked()
    busyTreeQuestion.settle(false)
    await running
    expect(requests).toHaveLength(1)
    // The busy answer is a question, not a failure.
    expect(actions.actionError).toBeNull()
  })
})
