import { afterAll, describe, expect, mock, test } from 'bun:test'
import type { WorkspaceContext } from '@solus/workspace-ui/contexts/workspace/workspace.context.svelte'

mock.module('@solus/workspace-ui/contexts/notifications/notifications.store.svelte', () => ({
  notificationsStore: { wants: () => false },
}))
mock.module('svelte-sonner', () => ({ toast: Object.assign(() => '', { success: () => '', error: () => '', info: () => '', dismiss: () => {} }) }))

const originalState = Object.getOwnPropertyDescriptor(globalThis, '$state')
Object.defineProperty(globalThis, '$state', { configurable: true, value: <T>(value: T): T => value })
afterAll(() => {
  if (originalState) Object.defineProperty(globalThis, '$state', originalState)
  else Reflect.deleteProperty(globalThis, '$state')
})

const { openResourceInWorkspace } = await import('@solus/workspace-ui/contexts/app/resource-routes')
const { connectionsNav } = await import('@solus/workspace-ui/components/connections/connections-nav.svelte')
const { pairCodeRequest } = await import('@solus/workspace-ui/components/connections/lib/access-tab-requests.svelte')
const { toQuestionRequest } = await import('@solus/workspace-ui/contexts/workspace/session.utils')

function workspace(): { session: WorkspaceContext; settings: string[]; navigations: unknown[] } {
  const settings: string[] = []
  const navigations: unknown[] = []
  const shell = { showSettings: (tab: string) => { settings.push(tab) }, router: { navigate: (ref: unknown) => { navigations.push(ref) } } }
  // SAFETY: the connections route reads only showSettings and router.navigate from the workspace.
  return { session: shell as unknown as WorkspaceContext, settings, navigations }
}

describe('the connections route', () => {
  test('with pair, it opens Sharing & access for the host and asks that host for a code once', () => {
    // WHY: "Show the code on <name>" must land where the code is, with the code already made.
    // The code is on Settings › Sharing & access; the host page has no Access tab, as in T3 Code.
    const { session, settings, navigations } = workspace()
    openResourceInWorkspace(session, { kind: 'connections', serverId: 'studio', pair: true })
    expect(settings).toEqual([])
    expect(navigations).toEqual([{ name: 'settings', params: { tab: 'sharing', host: 'studio' } }])
    expect(pairCodeRequest.take('mac')).toBe(false)
    expect(pairCodeRequest.take('studio')).toBe(true)
    expect(pairCodeRequest.take('studio')).toBe(false)
  })

  test('with a tab and no pair, it opens that tab and makes no code', () => {
    const { session } = workspace()
    openResourceInWorkspace(session, { kind: 'connections', serverId: 'studio', tab: 'git' })
    expect(connectionsNav.tab).toBe('git')
    expect(pairCodeRequest.serverId).toBeNull()
  })

  test('with no tab, a host opens on its overview', () => {
    const { session } = workspace()
    openResourceInWorkspace(session, { kind: 'connections', serverId: 'studio' })
    expect(connectionsNav.tab).toBe('overview')
  })
})

test('a host-link question keeps the ask the card shows', () => {
  // WHY: without the ask, the card cannot rank the machines or say why the agent asks.
  const request = toQuestionRequest({ type: 'question_request', questionId: 'q1', questions: [], kind: 'host-link', hostLink: { reason: 'Link the Windows machine.', url: 'http://10.10.1.10:4317' } })
  expect(request.kind).toBe('host-link')
  expect(request.hostLink).toEqual({ reason: 'Link the Windows machine.', url: 'http://10.10.1.10:4317' })
})
