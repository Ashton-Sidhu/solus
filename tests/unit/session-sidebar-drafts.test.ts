import { beforeAll, describe, expect, mock, test } from 'bun:test'
import type { Session } from '@solus/contracts/types'
import type { SidebarTask } from '@solus/workspace-ui/components/session/lib/task-list'
import { makePrompt } from '@solus/workspace-ui/contexts/workspace/session.factories'
import type { SessionSidebarStore as SidebarStore } from '@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'

mock.module('@solus/workspace-ui/contexts/connections/connections.store.svelte', () => ({ connectionsStore: {} }))
mock.module('@solus/workspace-ui/contexts/projects/projects.store.svelte', () => ({ projectsStore: {} }))
mock.module('@solus/workspace-ui/components/review/review-guide.store.svelte', () => ({ reviewGuideStore: {}, sessionGuideIdentity: () => null }))
mock.module('@solus/workspace-ui/contexts/prs/session-pull-requests.store.svelte', () => ({ sessionPullRequestsStore: {}, sessionPrLink: () => null }))
mock.module('@solus/workspace-ui/contexts/workspace/session-states.store.svelte', () => ({ sessionStatesStore: {} }))
let SessionSidebarStore: typeof SidebarStore
beforeAll(async () => {
  ;({ SessionSidebarStore } = await import('@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'))
})

function sidebar() {
  const sessions = new Map<string, Pick<Session, 'prompt'>>([
    ['first', { prompt: makePrompt({ text: 'Follow up on the result' }) }],
    ['second', { prompt: makePrompt() }],
  ])
  const shown = new Set(['first'])
  const selected: string[] = []
  const store = Object.create(SessionSidebarStore.prototype) as SidebarStore
  Object.assign(store, {
    activeTasks: [
      { tabIds: ['first'] },
      { tabIds: ['second'] },
    ],
    session: {
      hasCompanionPanes: true,
      router: { panes: [{ id: 'lead' }, { id: 'aside' }] },
      chatTabIn: (paneId: string) => {
        const tabId = paneId === 'lead' ? 'first' : 'second'
        return shown.has(tabId) ? tabId : null
      },
      sessionFor: (tabId: string) => sessions.get(tabId),
      selectTab: (tabId: string) => selected.push(tabId),
    },
  })
  return { store, sessions, shown, selected }
}

describe('unsent prompts in open sidebar sessions', () => {
  test('moves to Drafts only after the conversation leaves the screen', () => {
    const { store, shown } = sidebar()
    expect([...store.parkedSessionTabIds]).toEqual([])
    shown.delete('first')
    expect([...store.parkedSessionTabIds]).toEqual(['first'])
    shown.add('first')
    expect([...store.parkedSessionTabIds]).toEqual([])
  })

  test('does not park a companion conversation or an empty prompt', () => {
    const { store, shown, sessions } = sidebar()
    shown.add('second')
    sessions.get('second')!.prompt.text = 'Keep typing beside the first session'
    expect([...store.parkedSessionTabIds]).toEqual([])
    shown.clear()
    sessions.get('first')!.prompt.text = ' \n '
    expect([...store.parkedSessionTabIds]).toEqual(['second'])
    sessions.get('second')!.prompt = makePrompt()
    expect([...store.parkedSessionTabIds]).toEqual([])
  })

  test('attachments earn a draft, while task rows keep their identity', () => {
    const { store, shown, sessions } = sidebar()
    shown.clear()
    sessions.get('first')!.prompt.text = ''
    sessions.get('first')!.prompt.attachments.push({ id: 'file' } as Session['prompt']['attachments'][number])
    expect([...store.parkedSessionTabIds]).toEqual(['first'])
    Object.assign(store, { activeTasks: [{ taskId: 'task', tabIds: ['first'] } satisfies Partial<SidebarTask>] })
    expect([...store.parkedSessionTabIds]).toEqual([])
  })

  test('a session draft opens its original conversation', () => {
    const { store, selected } = sidebar()
    store.openDraftRow({ draftId: 'session:first', tabId: 'first' } as Parameters<SidebarStore['openDraftRow']>[0])
    expect(selected).toEqual(['first'])
  })

  test('discard clears only the prompt and Undo restores it without replacing newer text', () => {
    const { store, sessions } = sidebar()
    const previousState = globalThis.$state
    globalThis.$state = Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => value }) as typeof $state
    try {
      const row = { draftId: 'session:first', tabId: 'first' } as Parameters<SidebarStore['discardDraftRow']>[0]
      const original = sessions.get('first')!.prompt
      const undo = store.discardDraftRow(row)
      expect(sessions.size).toBe(2)
      expect(sessions.get('first')!.prompt.text).toBe('')
      undo!()
      expect(sessions.get('first')!.prompt).toEqual(original)
      const undoAgain = store.discardDraftRow(row)
      sessions.get('first')!.prompt.text = 'New work'
      undoAgain!()
      expect(sessions.get('first')!.prompt.text).toBe('New work')
    } finally {
      globalThis.$state = previousState
    }
  })
})
