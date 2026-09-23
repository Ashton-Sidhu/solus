import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import type { GitActionResult } from '@solus/contracts/types'
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

function result(push: 'pushed' | 'skipped'): GitActionResult {
  return {
    commit: { status: 'created', subject: 'Change' },
    push: { status: push },
    pullRequest: { status: 'skipped' },
  } as GitActionResult
}

async function runAction(push: 'pushed' | 'skipped') {
  const { GitActions } = await import('@solus/workspace-ui/lib/git-actions.svelte')
  const refreshed: string[] = []
  const ctx = { session: { workingDirectory: '/repo' } }
  const session = {
    runFor: () => null,
    ctxForEnvironment: () => ctx,
    apiFor: () => ({ gitRunAction: async () => result(push) }),
    serverIdFor: () => 'host-a',
  }
  const environmentStore = {
    environmentFor: () => ({ cwd: '/repo', checkout: { branch: 'feature/x', targetBranch: 'main' } }),
    refreshEnvironment: async () => null,
    statusFor: () => null,
  }
  const pullRequests = {
    get: () => ({
      prForBranch: (branch: string) => ({ refreshDetail: async () => { refreshed.push(branch) } }),
      absorbCreated: () => {},
    }),
  }
  const actions = new GitActions(
    session as unknown as ConstructorParameters<typeof GitActions>[0],
    'tab-1',
    environmentStore as unknown as ConstructorParameters<typeof GitActions>[2],
    pullRequests as unknown as ConstructorParameters<typeof GitActions>[3],
  )
  await actions.run('commit_push')
  return refreshed
}

describe('a Git action that pushes', () => {
  test("re-reads the branch's pull request, because the push moved it", async () => {
    // WHY: mergeability and checks belong to the head. The rail used to learn
    // of a push through a flag and an effect; the push itself now says so,
    // whether or not the rail is on screen.
    expect(await runAction('pushed')).toEqual(['feature/x'])
  })

  test('leaves the pull request alone when nothing was pushed', async () => {
    expect(await runAction('skipped')).toEqual([])
  })
})
