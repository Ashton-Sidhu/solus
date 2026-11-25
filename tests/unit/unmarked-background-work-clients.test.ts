import { describe, expect, test } from 'bun:test'
import type { Session } from '@solus/contracts/types'
import { backgroundWorkIsServers, showsBackgroundWork } from '@solus/client-core/background-work'
import { SessionEventReducer, type SessionEventReducerDeps } from '@solus/workspace-ui/contexts/workspace/session-event-reducer.svelte'
import { TranscriptModel } from '../../apps/mobile/solus-core/features/conversation/lib/transcript-model'

// A Claude turn that leaves a dev server or its Monitor running, unmarked,
// completes (docs/background-work.md). The status no longer says that work
// runs, so every client reads the host's `background_work` fact to show the
// background row (desktop, web) or pill (mobile) and its Stop.

describe('when a client shows the background row', () => {
  test('in background, and after a completed turn while work still runs', () => {
    expect(showsBackgroundWork('background', false)).toBe(true)
    expect(showsBackgroundWork('completed', true)).toBe(true)
    expect(showsBackgroundWork('failed', true)).toBe(true)
  })

  test('not when nothing runs, and not over a live turn, which has its own Stop', () => {
    expect(showsBackgroundWork('completed', false)).toBe(false)
    expect(showsBackgroundWork('running', true)).toBe(false)
    expect(showsBackgroundWork('awaiting_input', true)).toBe(false)
  })
})

describe('desktop and web', () => {
  test('the reducer keeps the fact on the session, and the row follows it', () => {
    const session = { status: 'completed', messages: [], outboundPrompts: [], permissionQueue: [], questionQueue: [], rateLimitInfo: null } as unknown as Session
    const reducer = new SessionEventReducer({
      registry: { tabIdsBySession: new Map() },
      sessions: { byId: { session } },
      settings: { rateLimitBehavior: 'ask' },
      workStreamTracker: { sweep: () => {} },
      isSessionVisible: () => true,
      publishSessionViewed: () => {},
      playNotificationIfHidden: () => {},
      log: () => {},
    } as unknown as SessionEventReducerDeps)

    reducer.apply('session', { type: 'background_work', running: true })
    expect(showsBackgroundWork(session.status, !!session.backgroundWorkRunning)).toBe(true)
    reducer.apply('session', { type: 'background_work', running: false })
    expect(showsBackgroundWork(session.status, !!session.backgroundWorkRunning)).toBe(false)
  })
})

// Stop sets `interrupted` at once; the run exits after, and only then does the
// host say the background work ended with it.
describe('a session Stop', () => {
  test('clears the row on desktop and web', () => {
    const session = { status: 'completed', messages: [], outboundPrompts: [], permissionQueue: [], questionQueue: [], rateLimitInfo: null } as unknown as Session
    const reducer = new SessionEventReducer({
      registry: { tabIdsBySession: new Map() },
      sessions: { byId: { session } },
      settings: { rateLimitBehavior: 'ask' },
      workStreamTracker: { sweep: () => {} },
      isSessionVisible: () => true,
      publishSessionViewed: () => {},
      playNotificationIfHidden: () => {},
      log: () => {},
    } as unknown as SessionEventReducerDeps)

    reducer.apply('session', { type: 'background_work', running: true })
    session.status = 'interrupted'
    reducer.apply('session', { type: 'background_work', running: false })
    expect(showsBackgroundWork(session.status, !!session.backgroundWorkRunning)).toBe(false)
  })

  test('clears the pill on mobile', () => {
    const model = TranscriptModel.fromHistory('session-1', { messages: [], before: null })
    model.setStatus('completed')
    model.apply({ type: 'background_work', running: true })
    model.setStatus('interrupted')
    model.apply({ type: 'background_work', running: false })
    expect(showsBackgroundWork(model.status, model.backgroundWorkRunning)).toBe(false)
  })
})

describe('mobile', () => {
  test('the transcript model keeps the fact and tells the pill that it changed', () => {
    const model = TranscriptModel.fromHistory('session-1', { messages: [], before: null })
    model.setStatus('completed')
    model.takeChanges()

    model.apply({ type: 'background_work', running: true })
    expect(model.takeChanges().meta).toBe(true)
    expect(showsBackgroundWork(model.status, model.backgroundWorkRunning)).toBe(true)

    model.apply({ type: 'background_work', running: false })
    expect(showsBackgroundWork(model.status, model.backgroundWorkRunning)).toBe(false)
  })
})

// The host names each background task (`background_task_started`, and
// `RuntimeSessionInfo.backgroundTasks` for a client that joins), so the row
// says what runs even when an earlier turn launched it.
describe('the named tasks', () => {
  test('desktop and web keep them while they run, and drop them when the work ends', () => {
    const session = { status: 'completed', messages: [], outboundPrompts: [], permissionQueue: [], questionQueue: [], rateLimitInfo: null } as unknown as Session
    const reducer = new SessionEventReducer({
      registry: { tabIdsBySession: new Map() },
      sessions: { byId: { session } },
      settings: { rateLimitBehavior: 'ask' },
      workStreamTracker: { sweep: () => {} },
      isSessionVisible: () => true,
      publishSessionViewed: () => {},
      playNotificationIfHidden: () => {},
      log: () => {},
    } as unknown as SessionEventReducerDeps)

    reducer.apply('session', { type: 'background_task_started', taskId: 'dev', kind: 'command', description: 'Start the dev server' })
    reducer.apply('session', { type: 'background_task_started', taskId: 'watch', kind: 'monitor' })
    reducer.apply('session', { type: 'background_work', running: true })
    expect(session.backgroundTasks).toEqual([
      { taskId: 'dev', kind: 'command', description: 'Start the dev server' },
      { taskId: 'watch', kind: 'monitor' },
    ])
    reducer.apply('session', { type: 'background_task_settled', taskId: 'watch', status: 'completed' })
    expect(session.backgroundTasks?.map((task) => task.taskId)).toEqual(['dev'])
    reducer.apply('session', { type: 'background_work', running: false })
    expect(session.backgroundTasks).toEqual([])
  })

  test('mobile keeps the kind from the event and from a join', () => {
    const model = TranscriptModel.fromHistory('session-1', { messages: [], before: null })
    model.apply({ type: 'background_task_started', taskId: 'dev', kind: 'command', description: 'Start the dev server' })
    expect(model.backgroundTasks).toEqual([{ taskId: 'dev', kind: 'command', description: 'Start the dev server' }])

    const joined = TranscriptModel.fromHistory('session-2', { messages: [], before: null })
    joined.setBackgroundWorkRunning(true, ['dev'], [{ taskId: 'dev', kind: 'command', description: 'bun run dev' }])
    expect(joined.backgroundTasks).toEqual([{ taskId: 'dev', kind: 'command', description: 'bun run dev' }])
  })
})

// `hideServerBackgroundWork` leaves the row out only when the Running servers
// list already shows all that runs: it lists and stops those servers.
describe('background work that is only servers', () => {
  const dev = { kind: 'command' }

  test('is commands the agent left running, with as many servers of its own', () => {
    expect(backgroundWorkIsServers(false, [dev], 1)).toBe(true)
    expect(backgroundWorkIsServers(false, [dev], 2)).toBe(true)
  })

  test('keeps the row for work the list does not show', () => {
    // A command with no server of its own, such as a test watcher.
    expect(backgroundWorkIsServers(false, [dev, dev], 1)).toBe(false)
    expect(backgroundWorkIsServers(false, [dev], 0)).toBe(false)
    // A monitor, a sub-agent, or a task the host did not name is no server.
    expect(backgroundWorkIsServers(false, [dev, { kind: 'monitor' }], 2)).toBe(false)
    expect(backgroundWorkIsServers(false, [{ kind: 'background_task' }], 1)).toBe(false)
    expect(backgroundWorkIsServers(false, [], 1)).toBe(false)
    expect(backgroundWorkIsServers(false, undefined, 1)).toBe(false)
  })

  test('keeps the row while the agent waits on the work', () => {
    // An awaited wait holds the session in `background`: the agent acts on its result.
    expect(backgroundWorkIsServers(true, [dev], 1)).toBe(false)
  })
})
