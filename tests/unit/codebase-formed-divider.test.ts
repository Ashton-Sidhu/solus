import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { Activity } from '@solus/contracts/activity'
import type { WireSessionLoadMessage } from '@solus/contracts/session-history'
import type { IpcContext, Message, Session } from '@solus/contracts/types'
import type { User } from '@solus/contracts/user'
import type { WorkspaceContext } from '@solus/workspace-ui/contexts/workspace/workspace.context.svelte'
import { activityLine, dividesThread, showsActivity } from '@solus/workspace-ui/components/activity/lib/activity-line'
import { codebaseDividerFolders } from '@solus/workspace-ui/components/conversation/lib/codebase-divider'
import { SessionEventReducer, type SessionEventReducerDeps } from '@solus/workspace-ui/contexts/workspace/session-event-reducer.svelte'
import { codebaseOf, folderLocation } from '@solus/workspace-ui/contexts/workspace/run-location'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connections = singleHostServerConnections()
mock.module('@solus/client-core/server-connections', () => ({ serverConnections: connections }))
const { materializeSessionTranscript } = await import('@solus/workspace-ui/contexts/workspace/session-transcript')

// docs/plans/codebases.md decision 13: the host makes a codebase for a session
// with no step by the person. The conversation says so with a divider at the
// point where the codebase formed, as it does for a move into a worktree. The
// divider is an activity that the host stores, so a reload and a second client
// show the same line at the same place. A toast said it before, and a toast is
// gone after a reload.

const previousState = Object.getOwnPropertyDescriptor(globalThis, '$state')
afterEach(() => {
  connections.reset()
  if (previousState) Object.defineProperty(globalThis, '$state', previousState)
  else delete (globalThis as unknown as { $state?: unknown }).$state
})

const ALICE: User = { id: { kind: 'account', accountId: 'alice' }, displayName: 'Alice Moreau' }
const BOB: User = { id: { kind: 'account', accountId: 'bob' }, displayName: 'Bob' }

let nextId = 0
/** The record that the host writes when it makes a codebase. Its author is the person of the turn: Alice here. */
function formed(name: string, folders: string[], at = 5): Extract<Activity, { kind: 'codebase_formed' }> {
  return { kind: 'codebase_formed', codebaseId: `${name}-1`, name, folders, id: `formed-${++nextId}`, subject: { kind: 'session', id: 'session' }, at, by: { kind: 'user', user: ALICE } }
}

/** The whole line of the divider, as `ActivityDivider` joins it: the words, the name of the codebase, the folders. */
function dividerText(activity: Extract<Activity, { kind: 'codebase_formed' }>, reader = ALICE.id): string {
  return [activityLine(activity, reader).text, activity.name, codebaseDividerFolders(activity.folders)].filter(Boolean).join(' ')
}

describe('the text of the divider', () => {
  // Rule 2: the codebase has one root, the project folder.
  test('a codebase made from one folder names the codebase and the folder, with no end period', () => {
    expect(dividerText(formed('shop', ['shop']))).toBe('Made the codebase shop from the folder shop')
  })

  // Rule 4: the project folder and the attached folder.
  test('a codebase made from two folders names the two', () => {
    expect(dividerText(formed('solus', ['solus', 'solus-cloud']))).toBe('Made the codebase solus from the folders solus and solus-cloud')
    expect(dividerText(formed('solus', ['solus', 'solus-cloud', 'site']))).toBe('Made the codebase solus from the folders solus, solus-cloud and site')
  })

  test('a record with no folder name names only the codebase', () => {
    expect(dividerText(formed('shop', []))).toBe('Made the codebase shop')
  })

  // The codebase formed in a turn of Alice. As each divider, the line names the person only for a different reader.
  test('the line is the news of the thread: each reader sees it, and no fold hides it', () => {
    const activity = formed('shop', ['shop'])
    expect(activityLine(activity, ALICE.id)).toMatchObject({ person: null, who: '', predicate: 'Made the codebase' })
    expect(activityLine(activity, BOB.id)).toMatchObject({ person: ALICE, predicate: 'made the codebase' })
    // A session that an automation or an agent started has no person: the line names none.
    expect(activityLine({ ...activity, by: { kind: 'system' } }, BOB.id)).toMatchObject({ person: null, predicate: 'Made the codebase' })
    expect(showsActivity(activity, ALICE.id)).toBe(true)
    expect(showsActivity(activity, BOB.id)).toBe(true)
    expect(showsActivity(activity, null)).toBe(true)
    expect(dividesThread(activity)).toBe(true)
  })
})

function conversation(messages: Partial<Message>[]) {
  const session = {
    status: 'running', run: { location: folderLocation({ serverId: 'host-1', path: '/code/shop' }) }, messages,
    sessionFolders: [], outboundPrompts: [], currentTurnStartedAt: 1, permissionQueue: [], questionQueue: [], rateLimitInfo: null,
  } as unknown as Session
  const reducer = new SessionEventReducer({
    registry: {},
    sessions: { byId: { session } },
    settings: { rateLimitBehavior: 'ask' },
    planStore: { plans: {}, setStatus: () => {} },
    currentUserId: () => ALICE.id,
    playNotificationIfHidden: () => {},
    closePlanModal: () => {},
    log: () => {},
  } as unknown as SessionEventReducerDeps)
  const rows = () => session.messages.map((message) => message.activity?.kind ?? message.id)
  return { session, reducer, rows }
}

/** The rows that a client draws from the history that the host read: a reload, or a client that opens the session later. */
function reloaded(history: WireSessionLoadMessage[]): string[] {
  connections.registerPrimary('transcript-host', {})
  const ctx = { apiForSession: () => connections.apiFor('transcript-host') } as unknown as WorkspaceContext
  return materializeSessionTranscript(ctx, {
    sessionId: 'session', loadPath: '/code/shop', displayCwd: '/code/shop', provider: 'claude-code',
    ctx: { session: { sessionId: 'tab' } } as IpcContext,
  }, history).messages.map((message) => message.activity?.kind ?? message.id)
}

describe('the place of the divider in the conversation', () => {
  // The host makes the codebase at the turn start, after the bubble of the prompt is on screen.
  // The history has the divider before that prompt, so the live client puts it there too.
  test('a codebase made at a turn start goes before the prompt of that turn, live and after a reload', () => {
    const activity = formed('shop', ['shop'], 5)
    const { session, reducer, rows } = conversation([{ id: 'prompt', role: 'user', content: 'do the work', timestamp: 1 }])
    const prompt = session.messages[0]
    reducer.apply('session', { type: 'activity', activity })
    expect(rows()).toEqual(['codebase_formed', 'prompt'])
    // In place: the bubble of the prompt is the same object.
    expect(session.messages[1]).toBe(prompt)
    expect(session.messages[0]).toMatchObject({ id: `activity:${activity.id}`, role: 'system', activity })

    // The host merges the stored activity before the first row that came after it (`mergeSessionActivity`).
    expect(reloaded([
      { messageId: `activity:${activity.id}`, role: 'system', content: '', activity, timestamp: activity.at },
      { messageId: 'prompt', role: 'user', content: 'do the work', timestamp: 9 },
      { messageId: 'answer', role: 'assistant', content: 'Done.', timestamp: 20 },
    ])).toEqual(['codebase_formed', 'prompt', 'answer'])
  })

  // Rule 4: the agent attaches a folder in the middle of a turn.
  test('a codebase made in the middle of a turn goes where the turn is then', () => {
    const { reducer, rows } = conversation([
      { id: 'prompt', role: 'user', content: 'change the two folders', timestamp: 1 },
      { id: 'answer', role: 'assistant', content: 'I attach solus-cloud.', timestamp: 2 },
    ])
    reducer.apply('session', { type: 'activity', activity: formed('solus', ['solus', 'solus-cloud'], 5) })
    expect(rows()).toEqual(['prompt', 'answer', 'codebase_formed'])
  })

  // A client that joins gets a replay of the turn. Its history can have the divider already.
  test('a replay of the record adds no second divider', () => {
    const activity = formed('shop', ['shop'])
    const { reducer, rows } = conversation([{ id: 'prompt', role: 'user', content: 'do the work', timestamp: 1 }])
    reducer.apply('session', { type: 'activity', activity })
    reducer.apply('session', { type: 'activity', activity })
    expect(rows()).toEqual(['codebase_formed', 'prompt'])
  })

  // `session_codebase` is the state of the run only. The host sends it also when a session takes a codebase that exists.
  test('a session that takes a codebase that exists gets the codebase on its run, and no divider', () => {
    const { session, reducer, rows } = conversation([{ id: 'prompt', role: 'user', content: 'do the work', timestamp: 1 }])
    reducer.apply('session', { type: 'session_codebase', codebaseId: 'shop-1', name: 'shop' })
    expect(codebaseOf(session.run)).toBe('shop-1')
    expect(rows()).toEqual(['prompt'])
  })
})
