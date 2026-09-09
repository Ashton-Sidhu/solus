import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { findOpenTabForSession } from '@solus/workspace-ui/lib/sessionUtils'
import { visibleRef, type PaneEntry } from '@solus/workspace-ui/contexts/workspace/routing/location'
import { RouterStore } from '@solus/workspace-ui/contexts/workspace/routing/router.store.svelte'
import type { ClientShellContext } from '@solus/workspace-ui/contexts/app/client-shell.svelte'

// Run the production methods with a small mounted-workspace fixture. The full
// constructor starts host subscriptions, which are unrelated to visibility.
const source = readFileSync(new URL('../../packages/workspace-ui/src/contexts/workspace/workspace.context.svelte.ts', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('workspace.ts', source, ts.ScriptTarget.Latest, true)
const workspace = parsed.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'WorkspaceContext')
if (!workspace) throw new Error('WorkspaceContext declaration missing')
const selected = ['isSessionVisible', 'isSessionVisibleOnHost', 'showsConversation']
const methods = workspace.members.filter((node) => node.name && selected.includes(node.name.getText(parsed)))
if (methods.length !== selected.length) throw new Error('Workspace visibility methods missing')
const fixtureCode = new Bun.Transpiler({ loader: 'ts' }).transformSync(`class Visibility {
  ${methods.map((node) => node.getText(parsed)).join('\n')}
  visibleSession(sessionId) { return this.isSessionVisible(sessionId); }
}`)

interface VisibilityFixture {
  shell: Pick<ClientShellContext, 'visible' | 'hasCompanionPanes' | 'conversationVisible'>
  tabs: Record<string, { sessionId: string }>
  sessions: Record<string, { agentSessionId: string; run: { serverId: string } }>
  tabOrder: string[]
  activeTabId: string
  router: {
    leadingPane: PaneEntry
    asidePanes: PaneEntry[]
    pane(paneId: string): PaneEntry | null
    chatSessionIn(paneId: string): string | null
  }
  chatTabIn(paneId: string): string | null
  visibleSession(sessionId: string): boolean
  isSessionVisibleOnHost(serverId: string, sessionId: string): boolean
}

const Visibility: new () => VisibilityFixture = new Function('findOpenTabForSession', 'visibleRef', `${fixtureCode}; return Visibility`)(findOpenTabForSession, visibleRef)

function fixture(hasCompanionPanes = false): VisibilityFixture {
  const view = new Visibility()
  view.shell = { visible: true, hasCompanionPanes, conversationVisible: true }
  view.tabs = { primary: { sessionId: 'first' }, companion: { sessionId: 'second' } }
  view.sessions = {
    first: { agentSessionId: 'provider-first', run: { serverId: 'host-a' } },
    second: { agentSessionId: 'provider-second', run: { serverId: 'host-b' } },
  }
  view.tabOrder = ['primary', 'companion']
  view.activeTabId = 'primary'
  view.router = {
    leadingPane: { id: 'lead', base: { name: 'chat', params: {} }, overlay: null },
    asidePanes: [{ id: 'aside', base: { name: 'chat', params: { sessionId: 'second', serverId: 'host-b' } }, overlay: null }],
    pane(paneId) { return this.asidePanes.find((pane) => pane.id === paneId) ?? null },
    chatSessionIn: RouterStore.prototype.chatSessionIn,
  }
  view.chatTabIn = () => 'companion'
  return view
}

describe('which mounted conversations are visible', () => {
  test('mobile ignores retained companion panes', () => {
    const view = fixture()
    expect(view.visibleSession('first')).toBe(true)
    expect(view.isSessionVisibleOnHost('host-a', 'first')).toBe(true)
    expect(view.visibleSession('second')).toBe(false)
    expect(view.isSessionVisibleOnHost('host-b', 'second')).toBe(false)
  })

  test('a page or overlay hides the active conversation', () => {
    const view = fixture()
    view.router.leadingPane.base = { name: 'tasks', params: {} }
    expect(view.visibleSession('first')).toBe(false)
    expect(view.isSessionVisibleOnHost('host-a', 'first')).toBe(false)
    view.router.leadingPane.base = { name: 'chat', params: {} }
    view.router.leadingPane.overlay = { name: 'tasks', params: {} }
    expect(view.visibleSession('first')).toBe(false)
    expect(view.isSessionVisibleOnHost('host-a', 'first')).toBe(false)
  })

  test('wide layouts count a visible companion only on its own host', () => {
    const view = fixture(true)
    expect(view.visibleSession('second')).toBe(true)
    expect(view.isSessionVisibleOnHost('host-b', 'second')).toBe(true)
    expect(view.isSessionVisibleOnHost('host-a', 'second')).toBe(false)
    view.router.asidePanes[0].overlay = { name: 'tasks', params: {} }
    expect(view.visibleSession('second')).toBe(false)
    expect(view.isSessionVisibleOnHost('host-b', 'second')).toBe(false)
  })

  test('a hidden client marks no conversation visible', () => {
    const view = fixture(true)
    view.shell = { ...view.shell, visible: false }
    expect(view.visibleSession('first')).toBe(false)
    expect(view.visibleSession('second')).toBe(false)
    expect(view.isSessionVisibleOnHost('host-a', 'first')).toBe(false)
    expect(view.isSessionVisibleOnHost('host-b', 'second')).toBe(false)
  })

  test('a collapsed native conversation does not count as visible', () => {
    const view = fixture()
    view.shell = { ...view.shell, conversationVisible: false }
    expect(view.visibleSession('first')).toBe(false)
    expect(view.isSessionVisibleOnHost('host-a', 'first')).toBe(false)
  })
})
