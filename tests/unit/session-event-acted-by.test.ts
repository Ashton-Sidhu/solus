import { describe, expect, test } from 'bun:test'
import type { Activity, ActivityKind } from '@solus/contracts/activity'
import type { Message, Session } from '@solus/contracts/types'
import { SessionEventReducer, type SessionEventReducerDeps } from '@solus/workspace-ui/contexts/workspace/session-event-reducer.svelte'
import { actorName } from '@solus/workspace-ui/components/presence/lib/actor-name'
import { activityLine, showsActivity } from '@solus/workspace-ui/components/activity/lib/activity-line'
import { buildTurns, groupMessages } from '@solus/workspace-ui/components/conversation/lib/turns'
import { parseUserKey, type User, type UserId } from '@solus/contracts/user'

// plans/004-shared-host-collaboration.md D2, D12, F4, step 12 and
// plans/012-user-actor-and-activity.md §5: who stopped, answered, decided,
// renamed or shared is one activity the host records and sends. The client
// appends it in place and draws it with one row; "you" names only the reader,
// and a session where the reader acts alone stays quiet.

const BOB: User = { id: { kind: 'account', accountId: 'bob' }, displayName: 'Bob' }
const ALICE: User = { id: { kind: 'account', accountId: 'alice' }, displayName: 'Alice Moreau' }

let nextId = 0
function activity(kind: ActivityKind, by: User | null = BOB, at = 5): Activity {
  return { ...kind, id: `a${++nextId}`, subject: { kind: 'session', id: 'session' }, at, by: by ? { kind: 'user', user: by } : { kind: 'system' } }
}

function roomFixture(options: { self?: string | null; plans?: Record<string, { status: string; questionId?: string }>; status?: string } = {}) {
  const session = {
    status: options.status ?? 'running', run: { serverId: 'host-1' }, messages: [{ id: 'u1', role: 'user', content: 'go', timestamp: 1 }],
    outboundPrompts: [], currentTurnStartedAt: 1, permissionQueue: [], questionQueue: [], rateLimitInfo: null,
  } as unknown as Session
  const plans = options.plans ?? {}
  const reducer = new SessionEventReducer({
    registry: {},
    sessions: { byId: { session } },
    settings: { rateLimitBehavior: 'ask' },
    planStore: { plans, setStatus: (planId: string, status: string) => { plans[planId].status = status } },
    currentUserId: () => (options.self === null ? null : parseUserKey(options.self ?? 'alice')),
    playNotificationIfHidden: () => {},
    closePlanModal: () => {},
    log: () => {},
  } as unknown as SessionEventReducerDeps)
  const rows = () => session.messages.flatMap((message) => message.activity ? [message.activity.kind] : [])
  return { session, reducer, rows }
}

describe('activity in the reducer', () => {
  test('a teammate\'s activity is appended in place, once, even when a replay repeats it', () => {
    const { session, reducer, rows } = roomFixture()
    const renamed = activity({ kind: 'renamed', title: 'Deploy' })
    const first = session.messages[0]
    reducer.apply('session', { type: 'activity', activity: renamed })
    reducer.apply('session', { type: 'activity', activity: renamed })
    expect(rows()).toEqual(['renamed'])
    // In place: the transcript array and its first message are the same objects.
    expect(session.messages[0]).toBe(first)
    expect(session.messages.at(-1)).toMatchObject({ id: `activity:${renamed.id}`, role: 'system', timestamp: 5, activity: renamed })
  })

  test('the reader\'s own notices are not drawn; a stop always is, for the turn\'s end to name', () => {
    const { reducer, rows } = roomFixture({ self: 'bob' })
    reducer.apply('session', { type: 'activity', activity: activity({ kind: 'permission_decided', questionId: 'q1', tool: 'Bash', decision: 'approved' }) })
    reducer.apply('session', { type: 'activity', activity: activity({ kind: 'renamed', title: 'x' }) })
    reducer.apply('session', { type: 'activity', activity: activity({ kind: 'stopped' }) })
    expect(rows()).toEqual(['stopped'])
  })

  test('a fork, a move, an agent switch and a plan\'s fresh session are drawn for the reader who made them too', () => {
    const { reducer, rows } = roomFixture({ self: 'bob' })
    reducer.apply('session', { type: 'activity', activity: activity({ kind: 'forked', sourceSessionId: 'thread-0' }) })
    reducer.apply('session', { type: 'activity', activity: activity({ kind: 'moved_to_worktree', path: '/wt', branch: 'solus/x' }) })
    reducer.apply('session', { type: 'activity', activity: activity({ kind: 'agent_switched', provider: 'codex' }) })
    reducer.apply('session', { type: 'activity', activity: activity({ kind: 'plan_decided', planId: 'p', decision: 'accepted', newSessionId: 'session' }) })
    reducer.apply('session', { type: 'activity', activity: activity({ kind: 'plan_decided', planId: 'p', decision: 'accepted' }) })
    // WHY: these are the thread's own news, and the only divider the client
    // draws for them now (plans/012 §5); the reader's plain decision stays quiet.
    expect(rows()).toEqual(['forked', 'moved_to_worktree', 'agent_switched', 'plan_decided'])
  })

  test('a fork recorded as its first prompt dispatches goes before that prompt, where a reload puts it', () => {
    const { session, reducer } = roomFixture()
    reducer.apply('session', { type: 'activity', activity: activity({ kind: 'forked', sourceSessionId: 'thread-0' }) })
    expect(session.messages.map((message) => message.activity?.kind ?? message.role)).toEqual(['forked', 'user'])
  })

  test('a divider reads as the thread\'s news for the reader, and names another person', () => {
    const fork = activity({ kind: 'forked', sourceSessionId: 'thread-0', midRun: true })
    expect(activityLine(fork, BOB.id)).toMatchObject({ person: null, who: '', predicate: 'Forked mid-run from' })
    expect(activityLine(fork, ALICE.id)).toMatchObject({ person: BOB, predicate: 'forked mid-run from' })
    expect(activityLine(activity({ kind: 'plan_decided', planId: 'p', decision: 'accepted', newSessionId: 's' }, null), ALICE.id).predicate)
      .toBe('Started a new session implementing')
  })

  test('no row while the host has not said who the reader is: a wrong name is worse than none', () => {
    const { reducer, rows } = roomFixture({ self: null })
    reducer.apply('session', { type: 'activity', activity: activity({ kind: 'question_answered', questionId: 'q1' }) })
    expect(rows()).toEqual([])
  })

  test('a stop\'s activity still lands after the session reads as interrupted', () => {
    const { reducer, rows } = roomFixture({ status: 'interrupted' })
    reducer.apply('session', { type: 'activity', activity: activity({ kind: 'stopped' }) })
    expect(rows()).toEqual(['stopped'])
  })

  test('state events keep their state job and write no notice', () => {
    const { session, reducer } = roomFixture()
    session.outboundPrompts.push(
      { clientPromptId: 'a', queueId: 'q-alice', text: 'deploy', state: 'queued', enqueuedAt: 2, author: ALICE },
      { clientPromptId: 'b', queueId: 'q-bob', text: 'test', state: 'queued', enqueuedAt: 3, author: BOB },
    )
    reducer.apply('session', { type: 'prompt_dequeued', queueId: 'q-alice' })
    reducer.apply('session', { type: 'prompt_queue_updated', queueId: 'q-bob', text: 'test all' })
    reducer.apply('session', { type: 'rate_limit_resolved', sessionId: 'session', action: 'stop' })
    reducer.apply('session', { type: 'status_change', status: 'interrupted', oldStatus: 'running' })
    expect(session.outboundPrompts.map((prompt) => [prompt.queueId, prompt.text])).toEqual([['q-bob', 'test all']])
    expect(session.messages).toHaveLength(1)
  })

  test('a decided plan takes the decision as its status; who decided is an activity of its own', () => {
    const { session, reducer } = roomFixture({ plans: { p1: { status: 'pending', questionId: 'perm-1' } } })
    session.messages.push({ id: 'plan', role: 'plan', content: '', planId: 'p1', timestamp: 2 })
    reducer.apply('session', { type: 'permission_resolved', questionId: 'perm-1', decision: 'denied' })
    expect(session.messages).toHaveLength(2)
    expect(activityLine(activity({ kind: 'permission_decided', questionId: 'perm-1', tool: 'ExitPlanMode', decision: 'denied' }), parseUserKey('alice')).text).toBe('Bob denied the plan')
  })
})

describe('one sentence per activity', () => {
  const alice = parseUserKey('alice')
  const text = (kind: ActivityKind, by: User | null = BOB, self: UserId | null = alice) => activityLine(activity(kind, by), self).text

  test('each moved session fact reads as it did', () => {
    expect(text({ kind: 'permission_decided', questionId: 'q', tool: 'Bash', decision: 'approved_for_session' })).toBe('Bob approved Bash for this session')
    expect(text({ kind: 'question_answered', questionId: 'q' })).toBe('Bob answered the question')
    expect(text({ kind: 'rate_limit_decided', action: 'stop' })).toBe('Bob stopped and discarded the held prompt')
    expect(text({ kind: 'rate_limit_decided', action: 'wait' })).toBe('Bob queued the prompt until the limit resets')
    expect(text({ kind: 'queued_prompt_changed', queueId: 'q', change: 'removed', author: ALICE })).toBe('Bob removed your held prompt')
    expect(text({ kind: 'queued_prompt_changed', queueId: 'q', change: 'edited', author: { id: { kind: 'account', accountId: 'cara' }, displayName: 'Cara' } })).toBe('Bob edited Cara\'s held prompt')
    expect(text({ kind: 'seat_needed', provider: 'claude-code' })).toBe('Bob needs to connect a Claude seat on this host')
    expect(text({ kind: 'renamed', title: 'Deploy' })).toBe('Bob renamed this session')
    expect(text({ kind: 'shared', with: 'organization' })).toBe('Bob shared this session with the organization')
  })

  test('"you" only for the reader; a teammate is their chip', () => {
    const own = activityLine(activity({ kind: 'stopped' }, ALICE), alice)
    expect(own).toMatchObject({ person: null, who: 'You', text: 'You stopped the agent' })
    const teammate = activityLine(activity({ kind: 'stopped' }), alice)
    expect(teammate.person).toEqual(BOB)
    // An unknown reader is never "you".
    expect(activityLine(activity({ kind: 'stopped' }, ALICE), null).text).toBe('Alice Moreau stopped the agent')
    expect(showsActivity(activity({ kind: 'renamed', title: 'x' }, ALICE), alice)).toBe(false)
    expect(showsActivity(activity({ kind: 'renamed', title: 'x' }), alice)).toBe(true)
  })
})

describe('a stop at the turn\'s end', () => {
  const message = (fields: Partial<Message> & Pick<Message, 'id' | 'role'>): Message => ({ content: '', timestamp: 1, ...fields })
  const stop = (by: User) => message({ id: 'stop', role: 'system', timestamp: 4, activity: activity({ kind: 'stopped' }, by, 4) })

  test('names the stopper on the provider\'s notice and is not a row of its own', () => {
    const turns = buildTurns(groupMessages([
      message({ id: 'u1', role: 'user', content: 'go' }),
      message({ id: 'a1', role: 'assistant', content: 'working', timestamp: 2 }),
      message({ id: 'n1', role: 'system', content: '[Request interrupted by user]', timestamp: 3 }),
      stop(BOB),
    ]), { running: false })
    expect(turns[0].end).toMatchObject({ kind: 'stopped', by: BOB })
    expect([...turns[0].body, ...turns[0].tail].some((item) => item.kind === 'system')).toBe(false)
  })

  test('is the ending on a client that has no provider notice yet', () => {
    const turns = buildTurns(groupMessages([
      message({ id: 'u1', role: 'user', content: 'go' }),
      message({ id: 'a1', role: 'assistant', content: 'working', timestamp: 2 }),
      stop(ALICE),
    ]), { running: false })
    expect(turns[0].end).toEqual({ kind: 'stopped', cause: '', detail: '', timestamp: 4, by: ALICE })
  })
})

describe('the label helper', () => {
  test('"you" only for the reader\'s one id on the host, the name for anyone else, nothing when unknown', () => {
    expect(actorName(BOB, parseUserKey('bob'))).toBe('you')
    expect(actorName(BOB, parseUserKey('alice'))).toBe('Bob')
    expect(actorName(undefined, parseUserKey('bob'))).toBeNull()
  })

  test('"is this me" compares whole user ids (plans/012 §1): a local user is not the account with the same text', () => {
    // WHY: the reader carries one id per host. A key that only looks alike is someone else.
    const owner: User = { id: { kind: 'local', localId: 'bob' }, displayName: 'Ashton' }
    expect(actorName(owner, { kind: 'local', localId: 'bob' })).toBe('you')
    expect(actorName(owner, { kind: 'account', accountId: 'bob' })).toBe('Ashton')
    expect(actorName(BOB, { kind: 'guest', guestId: 'bob' })).toBe('Bob')
  })
})
