import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import type { Session } from '@solus/contracts/types'
import { makeSession, makeTab } from '@solus/workspace-ui/contexts/workspace/session.factories'
import { existingTaskId, taskBindingSessionId } from '@solus/workspace-ui/contexts/workspace/session-draft.svelte'
import { sidebarSessionIds } from '@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'

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
const ForkFixture = new Function('makeSession', 'makeTab', 'uuid', 'existingTaskId', 'taskBindingSessionId', 'requestInputFocus', 'findLastUserIndex', transpile(`
class Fixture {
  ${methodCode('workspace.context.svelte.ts', ['forkTab', 'ownedTaskId'])}
}
return Fixture
`))(makeSession, makeTab, crypto.randomUUID.bind(crypto), existingTaskId, taskBindingSessionId, () => {}, (messages: Session['messages']) => messages.findLastIndex((message) => message.role === 'user'))

function fixture() {
  const original = makeSession(settings, {
    id: 'source', agentSessionId: 'source-provider', task: { kind: 'existing', taskId: 'old-task' },
    messages: [{ id: 'answer', role: 'assistant', content: 'Settled answer', timestamp: 1 }],
    run: { serverId: 'run-host', taskServerId: 'task-host' },
  })
  const context = new ForkFixture()
  context.settings = settings
  context.sessions = { source: original }
  context.tabs = { sourceTab: makeTab(original.id, { id: 'sourceTab' }) }
  context.sessionFor = (tabId: string) => context.sessions[context.tabs[tabId]?.sessionId]
  context.tasksStore = { taskForSession: (sessionId: string) => sessionId === 'source' ? { id: 'same-subtask', parentId: 'parent' } : null }
  context.pluginCommands = { global: [], project: [] }
  context.addTabToOrder = () => {}
  context.setActiveTab = () => {}
  context.resetOverlays = () => {}
  context.environment = { refreshEnvironment: async () => {} }
  return { context, original }
}

describe('fork session ownership and identity', () => {
  test('Fork joins the exact durable task and keeps the source and execution hosts', async () => {
    const { context, original } = fixture()
    const tabId = await context.forkTab('sourceTab')
    const fork = context.sessionFor(tabId) as Session
    expect(fork.task).toEqual({ kind: 'existing', taskId: 'same-subtask' })
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
    expect(await context.forkTab('sourceTab')).toBeTruthy()
    expect(Object.keys(context.sessions)).toHaveLength(2)
  })

  test('pending fork previews exclude the active source turn', async () => {
    const { context, original } = fixture()
    original.status = 'running'
    original.messages.push({ id: 'active', role: 'user', content: 'Still running', timestamp: 2 })
    const fork = context.sessionFor(await context.forkTab('sourceTab')) as Session
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
    const tabId = await context.forkTab('sourceTab')
    context.apiFor = () => { throw new Error('A pending fork must not attach') }
    expect(await bootstrapFunction('hydrateTab')(context, { tabId })).toBe(true)
  })

  test('reconnect does not adopt the source session identity', async () => {
    const { context } = fixture()
    const tabId = await context.forkTab('sourceTab')
    const fork = context.sessionFor(tabId) as Session
    context.tabOrder = [tabId]
    context.turnSnapshots = {}
    context.tabIdsForSession = () => [tabId]
    context.apiFor = () => { throw new Error('A pending fork must not watch its source') }
    await bootstrapFunction('resyncRuntime')(context)
    expect(fork.forked).toBe(true)
    expect(fork.id).not.toBe('source')
    expect(context.runtimeSyncing).toBe(false)
  })
})

test('the saved fork retains its preview and cutoff without claiming a provider thread', async () => {
  const { context } = fixture()
  const tabId = await context.forkTab('sourceTab')
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

