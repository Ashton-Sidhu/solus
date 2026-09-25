import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import type { Session } from '@solus/contracts/types'
import { makeSession, makeTab } from '@solus/workspace-ui/contexts/workspace/session.factories'
import { existingTaskId, ownedTaskId, taskBindingSessionId } from '@solus/workspace-ui/contexts/workspace/session-draft.svelte'
import { sidebarSessionIds } from '@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'
import { sessionTitleRegenerationInput } from '@solus/workspace-ui/contexts/workspace/session-title-regeneration'

const root = '../../packages/workspace-ui/src/contexts/workspace/'
function source(file: string) {
  return ts.createSourceFile(file, readFileSync(new URL(root + file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
}
function methodCode(file: string, names: string[]) {
  const parsed = source(file)
  const owner = parsed.statements.find(ts.isClassDeclaration)!
  return owner.members.filter((member) => member.name && names.includes(member.name.getText(parsed)))
    .map((member) => member.getText(parsed)).join('\n')
}
function transpile(code: string) {
  return new Bun.Transpiler({ loader: 'ts' }).transformSync(code)
}
const settings = { rateLimitBehavior: 'ask' } as Parameters<typeof makeSession>[0]
// The fork lives in SessionOpening and the naming in SessionMetadata; each
// reaches the workspace through `this.workspace`, as in production.
const { Opening, Metadata } = new Function('makeSession', 'makeTab', 'uuid', 'existingTaskId', 'taskBindingSessionId', 'ownedTaskId', 'requestInputFocus', 'findLastUserIndex', 'sessionTitleRegenerationInput', 'serverConnections', 'hasHostCapability', transpile(`
class Opening {
  ${methodCode('session-opening.ts', ['forkTab'])}
}
class Metadata {
  metadataFinalizedTabs = new Set()
  regeneratingTitleSessionIds = new Set()
  ${methodCode('session-metadata.svelte.ts', ['renameTab', 'generateSessionMetadata', 'regenerateTabTitle'])}
}
return { Opening, Metadata }
`))(makeSession, makeTab, crypto.randomUUID.bind(crypto), existingTaskId, taskBindingSessionId, ownedTaskId, () => {}, (messages: Session['messages']) => messages.findLastIndex((message) => message.role === 'user'), sessionTitleRegenerationInput, {
  resolveId: (serverId: string) => serverId,
  cachedCapabilitiesFor: () => ({}),
}, () => false)

function fixture() {
  const original = makeSession(settings, {
    id: 'source', agentSessionId: 'source-provider', task: { kind: 'existing', taskId: 'old-task' },
    messages: [{ id: 'answer', role: 'assistant', content: 'Settled answer', timestamp: 1 }],
    run: { serverId: 'run-host', taskServerId: 'task-host' },
  })
  // SAFETY: the fixture supplies every workspace field these methods read.
  const context: any = {}
  context.opening = Object.assign(new Opening(), { workspace: context })
  context.metadata = Object.assign(new Metadata(), { workspace: context })
  context.settings = settings
  context.sessions = { byId: { source: original } }
  context.tabs = { sourceTab: makeTab(original.id, { id: 'sourceTab' }) }
  context.sessionFor = (tabId: string) => context.sessions.byId[context.tabs[tabId]?.sessionId]
  context.tasksStore = { taskForSession: (sessionId: string) => sessionId === 'source' ? { id: 'same-task' } : null }
  context.pluginCommands = { global: [], project: [] }
  context.addTabToOrder = () => {}
  context.setActiveTab = () => {}
  context.resetOverlays = () => {}
  context.environment = { refreshEnvironment: async () => {} }
  return { context, original }
}

describe('fork session ownership and identity', () => {
  test('a generated fork name never writes to the source', async () => {
    const { context, original } = fixture()
    original.title = 'Source name'
    original.messages.unshift({ id: 'prompt', role: 'user', content: 'Fix the bug', timestamp: 0 })
        context.promptComposer = { composeSessionMetadataContext: () => undefined }
    const writes: Array<{ sessionId: string; title: string | null }> = []
    context.apiFor = () => ({
      generateSessionMetadata: async () => ({ title: 'Generated fork name' }),
      setSessionTitle: async (sessionId: string, title: string | null) => { writes.push({ sessionId, title }) },
    })
    const tabId = await context.opening.forkTab('sourceTab')
    const fork = context.sessionFor(tabId) as Session
    await context.metadata.regenerateTabTitle(tabId)
    expect(fork.title).toBe('Generated fork name')
    expect(original.title).toBe('Source name')
    expect(writes).toEqual([])
    fork.agentSessionId = 'fork-provider'
    fork.forked = false
    await context.metadata.generateSessionMetadata(tabId)
    expect(writes).toEqual([{ sessionId: 'fork-provider', title: 'Generated fork name' }])
  })

  test('a fork rename waits for its own provider identity before saving', async () => {
    const { context, original } = fixture()
    original.title = 'Source name'
    const writes: Array<{ sessionId: string; title: string | null }> = []
    context.apiFor = () => ({
      setSessionTitle: async (sessionId: string, title: string | null) => { writes.push({ sessionId, title }) },
    })
    const tabId = await context.opening.forkTab('sourceTab')
    const fork = context.sessionFor(tabId) as Session

    await context.metadata.renameTab(tabId, 'Fork name')
    await context.metadata.generateSessionMetadata(tabId)
    expect(fork.title).toBe('Fork name')
    expect(original.title).toBe('Source name')
    expect(writes).toEqual([])

    // session_init replaces the branching ID and then saves the chosen name.
    fork.agentSessionId = 'fork-provider'
    fork.forked = false
    await context.metadata.generateSessionMetadata(tabId)
    expect(writes).toEqual([{ sessionId: 'fork-provider', title: 'Fork name' }])

    await context.metadata.renameTab(tabId, 'Updated fork name')
    await context.metadata.renameTab(tabId, '')
    expect(writes.slice(1)).toEqual([
      { sessionId: 'fork-provider', title: 'Updated fork name' },
      { sessionId: 'fork-provider', title: null },
    ])
    expect(original.title).toBe('Source name')
  })

  test('Fork joins the exact durable task and keeps the source and execution hosts', async () => {
    const { context, original } = fixture()
    const tabId = await context.opening.forkTab('sourceTab')
    const fork = context.sessionFor(tabId) as Session
    expect(fork.task).toEqual({ kind: 'existing', taskId: 'same-task' })
    expect(fork.id).not.toBe(original.id)
    expect(fork.run.serverId).toBe('run-host')
    expect(fork.run.taskServerId).toBe('task-host')
    expect(sidebarSessionIds(context.tabs[tabId], fork)).toEqual([fork.id])
    expect(original.agentSessionId).toBe('source-provider')
    expect(fork.messages.at(-1)?.forkSourceSessionId).toBe('source-provider')
    // Once the fork starts, its source must still resolve to the source tab.
    fork.forked = false
    fork.agentSessionId = 'fork-provider'
    expect(sidebarSessionIds(context.tabs[tabId], fork)).toEqual([fork.id, 'fork-provider'])
  })

  test('keeps the prepared fork usable when environment refresh fails', async () => {
    const { context } = fixture()
    context.environment.refreshEnvironment = async () => { throw new Error('offline') }
    expect(await context.opening.forkTab('sourceTab')).toBeTruthy()
    expect(Object.keys(context.sessions.byId)).toHaveLength(2)
  })

  test('pending fork previews exclude the active source turn', async () => {
    const { context, original } = fixture()
    original.status = 'running'
    original.messages.push({ id: 'active', role: 'user', content: 'Still running', timestamp: 2 })
    const fork = context.sessionFor(await context.opening.forkTab('sourceTab')) as Session
    expect(fork.messages.map((message) => message.content)).toEqual(['Settled answer', ''])
    expect(fork.forkExcludeLatestTurn).toBe(true)
  })
})

function bootstrapFunction(name: string) {
  const parsed = source('session-bootstrap.ts')
  const node = parsed.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name)!
  return new Function(transpile(`${node.getText(parsed).replace(/^export /, '')}; return ${name}`))()
}

describe('pending forks across connection changes', () => {
  test('reload does not read or attach the source runtime', async () => {
    const { context } = fixture()
    const tabId = await context.opening.forkTab('sourceTab')
    context.apiFor = () => { throw new Error('A pending fork must not attach') }
    expect(await bootstrapFunction('hydrateTab')(context, { tabId })).toBe(true)
  })

  test('reconnect does not adopt the source session identity', async () => {
    const { context } = fixture()
    const tabId = await context.opening.forkTab('sourceTab')
    const fork = context.sessionFor(tabId) as Session
    context.tabOrder = [tabId]
    context.lifecycle = { turnSnapshots: {}, runtimeSyncing: false }
    context.tabIdsForSession = () => [tabId]
    context.apiFor = () => { throw new Error('A pending fork must not watch its source') }
    await bootstrapFunction('resyncRuntime')(context)
    expect(fork.forked).toBe(true)
    expect(fork.id).not.toBe('source')
    expect(context.lifecycle.runtimeSyncing).toBe(false)
  })
})

test('the saved fork retains its preview and cutoff without claiming a provider thread', async () => {
  const { context } = fixture()
  const tabId = await context.opening.forkTab('sourceTab')
  const fork = context.sessionFor(tabId) as Session
  fork.forkExcludeLatestTurn = true
  context.tabOrder = [tabId]
  const parsed = source('tab-snapshot.ts')
  const declaration = parsed.statements.find(ts.isFunctionDeclaration)!
  const snapshot = new Function('loadServers', 'LOCAL_SERVER_ID', 'taskTargetFields', transpile(`${declaration.getText(parsed).replace(/^export /, '')}; return snapshotPersistedTabs`))(
    () => [], 'local', () => ({ pendingTaskId: 'same-subtask' }),
  )
  const saved = JSON.parse(JSON.stringify(snapshot(context)))[0]
  expect(saved.pendingFork.messages).toEqual(fork.messages)
  expect(saved.pendingFork.excludeLatestTurn).toBe(true)
  expect(saved.forkedFromSessionId).toBeNull()
  expect(saved.pendingTaskId).toBe('same-subtask')
  expect(saved.agentSessionId).toBe('source-provider')
})
