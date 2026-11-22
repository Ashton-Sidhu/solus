import { describe, expect, test } from 'bun:test'
import { SendOutbox } from '@solus/client-core/send-outbox'
import type { BranchRef } from '@solus/contracts/git-types'
import type { GitCheckoutBranchResult, IpcContext, PromptOptions } from '@solus/contracts/types'
import { ConversationController, type ConversationTarget } from '../../apps/mobile/solus-core/features/conversation/conversation-controller'
import { memoryKeyValueStore } from '../../apps/mobile/solus-core/platform/ports'
import { createHostWorld, FakeApi, healthFetch, type FakeTransport } from './helpers/native-mobile-fakes'
import { identityKeyFor } from './helpers/signing-host'

/** The branch picker of a new session's current checkout, as T3's: the host
 *  chooses where the work goes, and the draft follows its answer. */

const NEW: ConversationTarget = { hostId: 'inst-a', newSession: { sessionId: 'new-1', provider: 'claude-code', workingDirectory: '/work/app' } }
const ref = (name: string, remoteOnly = false): BranchRef => ({ name, activeAt: 1, remoteOnly, isDefault: false })
const checkout = (branch: string, worktreePath?: string): GitCheckoutBranchResult['gitContext'] =>
  worktreePath ? { branch, targetBranch: 'main', repoRoot: '/work/app', worktreePath } : { branch, targetBranch: 'main', repoRoot: '/work/app' }

async function open() {
  let answer: (ctx: IpcContext, branch: string) => GitCheckoutBranchResult = (_ctx, branch) => ({ success: true, gitContext: checkout(branch), workingDirectory: '/work/app' })
  const api = new FakeApi()
    .on('describeSession', () => ({ lineage: null, meta: null }))
    .on('loadSessionPage', () => ({ messages: [], before: null }))
    .on('watchSession', () => ({}))
    .on('unwatchSession', () => undefined)
    .on('setSessionReadState', () => Date.now())
    .on('prompt', () => ({ disposition: 'started' }))
    .on('gitCheckoutBranch', (ctx: IpcContext, branch: string) => answer(ctx, branch))
    .on('worktreeBranches', () => [ref('main'), ref('feature')])
    .on('gitIdentity', () => ({ repoRoot: '/work/app', headSha: 'abc', branch: 'main', targetBranch: 'main' }))
  const world = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'inst-a' }), api: () => api })
  await world.registry.load()
  await world.registry.savePaired({ id: 'inst-a', identityKey: identityKeyFor('inst-a'), label: 'A', url: 'http://a:1' }, 'ta')
  const connection = world.connections.connection('inst-a')!
  await (world.transports[0] as FakeTransport).accept()
  const outboxStorage = memoryKeyValueStore()
  let nextId = 0
  const controller = new ConversationController(NEW, {
    executionPreferences: () => ({}),
    connection,
    outbox: new SendOutbox(() => outboxStorage),
    runSettings: async () => ({ defaultPermissionMode: 'auto', defaultModels: {}, modelOptionsByProvider: {} }),
    organizationId: () => null,
    uuid: () => `client-${++nextId}`,
    onChange: () => undefined,
  })
  await controller.load()
  const prompts = () => api.callsOf('prompt') as Array<[IpcContext, PromptOptions]>
  const switches = () => (api.callsOf('gitCheckoutBranch') as Array<[IpcContext, string, { remoteOnly?: boolean }]>)
    .map(([ctx, branch, options]) => ({ cwd: ctx.session.workingDirectory, branch, remoteOnly: options.remoteOnly }))
  return { controller, api, prompts, switches, answerWith: (next: typeof answer) => { answer = next } }
}

describe('native current-checkout branch', () => {
  test('a branch in another worktree moves the draft there, and the first prompt starts there', async () => {
    // WHY: git cannot check the branch out in the project too. Only the host
    // knows the branch's worktree now; the session must start in that folder.
    const { controller, prompts, switches, answerWith } = await open()
    answerWith((_ctx, branch) => ({ success: true, gitContext: checkout(branch, '/work/feature'), workingDirectory: '/work/feature' }))
    expect(await controller.chooseCheckoutBranch(ref('feature', true))).toBeNull()
    expect(switches()).toEqual([{ cwd: '/work/app', branch: 'feature', remoteOnly: true }])
    expect(controller.checkoutBranch).toBe('feature')
    await controller.send('fix it')
    expect(prompts()[0]?.[0].session).toMatchObject({ workingDirectory: '/work/feature', worktreeBaseBranch: null })
  })

  test('the next pick asks about the project again, not the worktree the last pick named', async () => {
    const { controller, switches, answerWith } = await open()
    answerWith(() => ({ success: true, gitContext: checkout('feature', '/work/feature'), workingDirectory: '/work/feature' }))
    await controller.chooseCheckoutBranch(ref('feature'))
    answerWith((_ctx, branch) => ({ success: true, gitContext: checkout(branch), workingDirectory: '/work/app' }))
    await controller.chooseCheckoutBranch(ref('main'))
    expect(switches().map((call) => call.cwd)).toEqual(['/work/app', '/work/app'])
    expect(controller.run.workingDirectory).toBe('/work/app')
  })

  test('a new worktree and the current checkout both start from the project folder again', async () => {
    // WHY: as T3, leaving a worktree the host named returns to the project's
    // own checkout. A new worktree made inside that other worktree would be
    // filed under the wrong project.
    const { controller, prompts, answerWith } = await open()
    answerWith(() => ({ success: true, gitContext: checkout('feature', '/work/feature'), workingDirectory: '/work/feature' }))
    await controller.chooseCheckoutBranch(ref('feature'))
    controller.chooseWorktreeBase('main')
    expect(controller.run.workingDirectory).toBe('/work/app')
    controller.chooseWorktreeBase(null)
    expect(controller.run.workingDirectory).toBe('/work/app')
    expect(controller.checkoutBranch).toBeNull()
    await controller.send('fix it')
    expect(prompts()[0]?.[0].session).toMatchObject({ workingDirectory: '/work/app', worktreeBaseBranch: null })
  })

  test('the project keeps the branch a pick moved it to, through a new-worktree toggle', async () => {
    const { controller } = await open()
    await controller.chooseCheckoutBranch(ref('release'))
    controller.chooseWorktreeBase('release')
    controller.chooseWorktreeBase(null)
    expect(controller.checkoutBranch).toBe('release')
  })

  test('a refusal keeps the draft where it was and says why', async () => {
    const { controller, prompts, answerWith } = await open()
    answerWith(() => ({ success: false, error: 'A local branch named feature exists and does not track the remote branch.' }))
    expect(await controller.chooseCheckoutBranch(ref('feature', true))).toContain('does not track')
    answerWith(() => { throw new Error('Host disconnected') })
    expect(await controller.chooseCheckoutBranch(ref('feature'))).toBe('Host disconnected')
    expect(controller.checkoutBranch).toBeNull()
    await controller.send('fix it')
    expect(prompts()[0]?.[0].session.workingDirectory).toBe('/work/app')
  })

  test('an older host that names no folder switched the project itself', async () => {
    const { controller, answerWith } = await open()
    answerWith((_ctx, branch) => ({ success: true, gitContext: checkout(branch) }))
    expect(await controller.chooseCheckoutBranch(ref('feature'))).toBeNull()
    expect(controller.run.workingDirectory).toBe('/work/app')
    expect(controller.checkoutBranch).toBe('feature')
  })

  test('a draft in another worktree says so, and its list still describes the project checkout', async () => {
    // WHY: T3 labels the place "Current worktree", and reads the branch list in
    // the project. A list read in the worktree would badge the picked branch
    // as the project's current one, and the next pick would act on the project.
    const { controller, api, answerWith } = await open()
    expect(controller.checkoutWorktree).toBeNull()
    answerWith(() => ({ success: true, gitContext: checkout('feature', '/work/feature'), workingDirectory: '/work/feature' }))
    await controller.chooseCheckoutBranch(ref('feature'))
    expect(controller.checkoutWorktree).toBe('/work/feature')
    await controller.branches()
    expect((api.callsOf('worktreeBranches')[0]?.[0] as IpcContext).session.workingDirectory).toBe('/work/app')
    expect(api.callsOf('gitIdentity')).toEqual([['/work/app']])
    controller.chooseWorktreeBase('main')
    expect(controller.checkoutWorktree).toBeNull()
  })

  test('a started session cannot change its checkout', async () => {
    const { controller, switches } = await open()
    await controller.send('fix it')
    controller.run.agentSessionId = 'provider-thread'
    expect(await controller.chooseCheckoutBranch(ref('feature'))).not.toBeNull()
    expect(switches()).toEqual([])
  })
})
