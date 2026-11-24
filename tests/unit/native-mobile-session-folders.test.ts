import { describe, expect, test } from 'bun:test'
import { SendOutbox } from '@solus/client-core/send-outbox'
import type { CodebaseMember, SessionFolder } from '@solus/contracts/codebases'
import type { IpcContext, PromptOptions } from '@solus/contracts/types'
import { ConversationController, type ConversationTarget } from '../../apps/mobile/solus-core/features/conversation/conversation-controller'
import { memoryKeyValueStore } from '../../apps/mobile/solus-core/platform/ports'
import { createHostWorld, FakeApi, healthFetch, type FakeTransport } from './helpers/native-mobile-fakes'
import { identityKeyFor } from './helpers/signing-host'

/** The codebase and the folders of a native session (docs/plans/codebases.md §10): what its
 *  first prompt names, and what its folder commands ask the host. */

const TASK_FOLDER = '/data/solus-task-folders/fix-login-1a2b3c4d'
const NEW: ConversationTarget = { hostId: 'inst-a', newSession: { sessionId: 'new-1', provider: 'claude-code', workingDirectory: '/code/shop' } }
const SAVED: ConversationTarget = {
  hostId: 'inst-a',
  record: {
    sessionId: 'saved-1', provider: 'claude-code', projectPath: '-code-shop-web', cwd: `${TASK_FOLDER}/shop/web`, model: null,
    reasoningEffort: null, title: 'Fix login', customTitle: null, role: 'owner', projectRoot: '/code/shop/web', codebaseId: 'shop',
  },
}

const folder = (path: string, change: Partial<SessionFolder> = {}): SessionFolder =>
  ({ path, name: path.split('/').at(-1)!, state: 'git', repositoryPath: path, source: 'codebase', granted: true, ...change })

async function open(target: ConversationTarget) {
  let folders: SessionFolder[] = [folder(`${TASK_FOLDER}/shop/api`, { repositoryPath: '/code/shop/api' })]
  const docs: CodebaseMember = { path: '/code/shop/docs', name: 'docs', state: 'git', repositoryKey: null, rootPath: '/code/shop', discovered: true, hasCommit: true, submodule: false }
  const api = new FakeApi()
    .on('describeSession', () => ({ lineage: null, meta: null }))
    .on('loadSessionPage', () => ({ messages: [], before: null }))
    .on('watchSession', () => ({}))
    .on('unwatchSession', () => undefined)
    .on('setSessionReadState', () => Date.now())
    .on('prompt', () => ({ disposition: 'started' }))
    .on('sessionFolders', () => folders)
    .on('sessionAttachFolder', (_sessionId: string, path: string) => (folders = [...folders, folder(path, { source: 'attached' })]))
    .on('sessionDetachFolder', (_sessionId: string, path: string) => (folders = folders.filter((each) => each.path !== path)))
    .on('sessionWorktreeCandidates', () => [docs])
    .on('sessionAddRepositoryWorktree', (_sessionId: string, repositoryPath: string) =>
      (folders = [...folders, folder(`${TASK_FOLDER}/shop/docs`, { repositoryPath })]))
  const world = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'inst-a' }), api: () => api })
  await world.registry.load()
  await world.registry.savePaired({ id: 'inst-a', identityKey: identityKeyFor('inst-a'), label: 'A', url: 'http://a:1' }, 'ta')
  const connection = world.connections.connection('inst-a')!
  const transport = world.transports[0] as FakeTransport
  await transport.accept()
  const outboxStorage = memoryKeyValueStore()
  let nextId = 0
  const controller = new ConversationController(target, {
    connection,
    outbox: new SendOutbox(() => outboxStorage),
    runSettings: async () => ({ defaultPermissionMode: 'auto', defaultModels: {}, modelOptionsByProvider: {} }),
    organizationId: () => null,
    uuid: () => `client-${++nextId}`,
    onChange: () => undefined,
  })
  await controller.load()
  const prompts = () => api.callsOf('prompt') as Array<[IpcContext, PromptOptions]>
  return { controller, api, prompts, transport }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('native session codebase and folders', () => {
  test('the first prompt of a new worktree session names its codebase and its repositories, one time', async () => {
    // WHY: the host makes the task folder from the first prompt only. A later prompt must not ask for a second one.
    const { controller, prompts } = await open(NEW)
    controller.followFolderCodebase('shop')
    controller.chooseWorktreeBase('main')
    controller.chooseWorktreeRepositories(['/code/shop/api'])
    await controller.send('fix the login')
    expect(prompts()[0]?.[0].session).toMatchObject({ codebaseId: 'shop', worktreeBaseBranch: 'main', worktreeRepositories: ['/code/shop/api'] })
    await controller.send('and the test')
    expect(prompts()[1]?.[0].session).toMatchObject({ codebaseId: 'shop', worktreeBaseBranch: null, worktreeRepositories: null })
  })

  test("the folder's codebase does not replace the choice of the person", async () => {
    const { controller, prompts } = await open(NEW)
    controller.followFolderCodebase('shop')
    expect(controller.run.codebaseId).toBe('shop')
    // "No codebase" is a choice: a later read of the folder's codebases leaves it.
    controller.chooseCodebase(null)
    controller.followFolderCodebase('shop')
    expect(controller.run.codebaseId).toBeNull()
    await controller.send('hello')
    expect(prompts()[0]?.[0].session.codebaseId).toBeNull()
  })

  test('"No codebase" reaches the host with the prompt, and a codebase that the person chooses takes it back', async () => {
    // WHY: the host gives a session with no codebase the codebase of its folder, or makes one (decision 13).
    const { controller, prompts } = await open(NEW)
    controller.chooseCodebase(null)
    await controller.send('hello')
    expect(prompts()[0]?.[0].session).toMatchObject({ codebaseId: null, noCodebase: true })

    const chosen = await open(NEW)
    chosen.controller.chooseCodebase(null)
    chosen.controller.chooseCodebase('shop')
    await chosen.controller.send('hello')
    expect(chosen.prompts()[0]?.[0].session.codebaseId).toBe('shop')
    expect('noCodebase' in chosen.prompts()[0]![0].session).toBe(false)
  })

  test('a draft that the person did not decide says nothing about a codebase', async () => {
    // WHY: with no word from the phone, the host forms or takes the codebase of the folder.
    const { controller, prompts } = await open(NEW)
    await controller.send('hello')
    expect('noCodebase' in prompts()[0]![0].session).toBe(false)
  })

  test('the host gives the session a codebase, and the next prompt names it', async () => {
    // WHY: the host made the codebase at the first prompt. The phone must not send "no codebase" for the session after that.
    const { controller, prompts, transport } = await open(NEW)
    await controller.send('fix the login')
    expect(prompts()[0]?.[0].session.codebaseId).toBeNull()
    transport.emitSession('new-1', { type: 'session_codebase', codebaseId: 'formed-1', name: 'shop' })
    expect(controller.run.codebaseId).toBe('formed-1')
    await controller.send('and the test')
    expect(prompts()[1]?.[0].session.codebaseId).toBe('formed-1')
  })

  test('a different codebase starts the repository choice again', async () => {
    // WHY: the chosen paths are members of the first codebase, which the second one does not have.
    const { controller } = await open(NEW)
    controller.chooseCodebase('shop')
    controller.chooseWorktreeRepositories(['/code/shop/api'])
    controller.chooseCodebase('platform')
    expect(controller.run.worktreeRepositories).toBeNull()
  })

  test('a session in a task folder names its project from its record', async () => {
    // WHY: the path of a task folder does not name the project, and the host reads the project's settings from `projectPath`.
    const { controller, prompts } = await open(SAVED)
    expect(controller.projectRoot).toBe('/code/shop/web')
    expect(controller.worksInTaskFolder).toBe(true)
    await controller.send('continue')
    expect(prompts()[0]?.[0].session).toMatchObject({ workingDirectory: `${TASK_FOLDER}/shop/web`, projectPath: '/code/shop/web', codebaseId: 'shop' })
  })

  test('an open session reads its folders, and each folder command shows the answer of the host', async () => {
    const { controller, api } = await open(SAVED)
    await settle()
    expect(controller.sessionFolders.map((each) => each.name)).toEqual(['api'])

    expect((await controller.worktreeCandidates()).map((member) => member.path)).toEqual(['/code/shop/docs'])
    await controller.addRepositoryWorktree('/code/shop/docs')
    expect(api.callsOf('sessionAddRepositoryWorktree')).toEqual([['saved-1', '/code/shop/docs']])
    expect(controller.sessionFolders.map((each) => each.path)).toEqual([`${TASK_FOLDER}/shop/api`, `${TASK_FOLDER}/shop/docs`])

    await controller.attachFolder('/code/notes')
    expect(controller.sessionFolders.at(-1)).toMatchObject({ path: '/code/notes', source: 'attached' })
    await controller.detachFolder('/code/notes')
    expect(api.callsOf('sessionDetachFolder')).toEqual([['saved-1', '/code/notes']])
    expect(controller.sessionFolders.some((each) => each.path === '/code/notes')).toBe(false)
  })

  test('a Git call about a session folder names the folder and keeps the session', async () => {
    const { controller } = await open(SAVED)
    await settle()
    const context = controller.folderContext(controller.sessionFolders[0]!)
    expect(context.session).toMatchObject({ sessionId: 'saved-1', workingDirectory: `${TASK_FOLDER}/shop/api`, projectPath: '/code/shop/api', gitContext: null })
  })

  test('a draft has no folders to read', async () => {
    const { controller, api } = await open(NEW)
    await controller.refreshSessionFolders()
    expect(api.callsOf('sessionFolders')).toEqual([])
  })
})
