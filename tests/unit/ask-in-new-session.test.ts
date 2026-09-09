import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import type { TaskTarget } from '@solus/contracts/types'
import { quotedReplyDraft } from '@solus/workspace-ui/lib/quoted-reply'
import { existingTaskId, taskBindingSessionId } from '@solus/workspace-ui/contexts/workspace/session-draft.svelte'

// Exercise the production methods without starting workspace host subscriptions.
const source = readFileSync(new URL('../../packages/workspace-ui/src/contexts/workspace/workspace.context.svelte.ts', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('workspace.ts', source, ts.ScriptTarget.Latest, true)
const workspace = parsed.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'WorkspaceContext')!
const names = ['askInNewSession', 'ownedTaskId']
const methods = workspace.members.filter((node) => node.name && names.includes(node.name.getText(parsed)))
if (methods.length !== names.length) throw new Error('Workspace methods missing')
const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(`class Fixture { ${methods.map((node) => node.getText(parsed)).join('\n')} }`)

interface SourceSession {
  id: string
  agentSessionId: string
  handoffId: string | null
  task: TaskTarget
  prompt: { text: string }
}
interface Fixture {
  activeTabId: string
  splitChatTabId: string | null
  sessionFor(tabId: string): SourceSession
  tasksStore: { taskForSession(sessionId: string): { id: string; parentId?: string } | null }
  forkTab(tabId: string, options: { activate: boolean; task: TaskTarget }): Promise<string>
  openSplitChat(sessionId: string): void
  askInNewSession(tabId: string, text: string): Promise<void>
}
const FixtureClass: new () => Fixture = new Function('quotedReplyDraft', 'taskBindingSessionId', 'existingTaskId', 'requestInputFocus', `${code}; return Fixture`)(quotedReplyDraft, taskBindingSessionId, existingTaskId, () => {})

async function ask(task: TaskTarget, boundTask?: { id: string; parentId?: string }, handoffId: string | null = null) {
  const fixture = new FixtureClass()
  const original: SourceSession = { id: 'stable-source', agentSessionId: 'provider-source', handoffId, task, prompt: { text: '' } }
  const forked: SourceSession = { ...original, id: 'new-session', prompt: { text: '' } }
  let requestedTask: TaskTarget | undefined
  let bindingId = ''
  let openedSessionId = ''
  fixture.activeTabId = 'source-tab'
  fixture.splitChatTabId = null
  fixture.sessionFor = (tabId) => tabId === 'source-tab' ? original : forked
  fixture.tasksStore = { taskForSession: (sessionId) => { bindingId = sessionId; return boundTask ?? null } }
  fixture.forkTab = async (tabId, options) => {
    expect(tabId).toBe('source-tab')
    expect(options.activate).toBe(false)
    requestedTask = options.task
    return 'fork-tab'
  }
  fixture.openSplitChat = (sessionId) => { openedSessionId = sessionId }
  await fixture.askInNewSession('source-tab', 'Selected answer')
  expect(forked.prompt.text).toBe('> Selected answer\n\n')
  expect(openedSessionId).toBe('new-session')
  return { requestedTask, bindingId }
}

describe('ask in new session task ownership', () => {
  test('uses the source task instead of requesting a new subtask', async () => {
    const result = await ask({ kind: 'new' }, { id: 'source-task' })
    expect(result.requestedTask).toEqual({ kind: 'existing', taskId: 'source-task' })
    expect(result.bindingId).toBe('stable-source')
  })

  test('keeps the exact subtask and honors a durable task transfer', async () => {
    const result = await ask({ kind: 'existing', taskId: 'old-task' }, { id: 'source-subtask', parentId: 'parent-task' }, 'handoff-session')
    expect(result.requestedTask).toEqual({ kind: 'existing', taskId: 'source-subtask' })
    expect(result.bindingId).toBe('handoff-session')
  })

  test('uses the saved task before the task store has its link', async () => {
    expect((await ask({ kind: 'existing', taskId: 'saved-task' })).requestedTask)
      .toEqual({ kind: 'existing', taskId: 'saved-task' })
  })

  test('preserves an explicit choice to have no task', async () => {
    expect((await ask({ kind: 'none' })).requestedTask).toEqual({ kind: 'none' })
  })
})
