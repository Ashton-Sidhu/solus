import { describe, expect, test } from 'bun:test'
import type { Session } from '@solus/contracts/types'
import { showsBackgroundWork } from '@solus/client-core/background-work'
import { SessionEventReducer, type SessionEventReducerDeps } from '@solus/workspace-ui/contexts/workspace/session-event-reducer.svelte'
import { TranscriptModel } from '../../apps/mobile/src/features/conversation/lib/transcript-model'

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
