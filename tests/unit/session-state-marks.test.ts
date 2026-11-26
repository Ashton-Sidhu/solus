import { describe, expect, test } from 'bun:test'
import type { PermissionRequest, QuestionRequest, Session, SessionStatus, Tab } from '@solus/contracts/types'
import {
  attentionLabel,
  getAttentionMark,
  getAttentionState,
  isHostUnreachable,
  liveDotMark,
} from '@solus/workspace-ui/lib/sessionUtils'
import { glyphWord } from '@solus/workspace-ui/components/session/lib/sidebar-rows'
import { needsAttention } from '@solus/workspace-ui/components/session/lib/sidebar-project-folders'

// The state marks of docs/plans/session-state-marks.md, as an open tab derives
// them. A row with no tab reads the same states from the status feed
// (sidebar-session-status.test.ts).

const tab = { hasUnread: false } as Tab
const permission: PermissionRequest = { questionId: 'perm-1', toolTitle: 'Bash', options: [] }
const question: QuestionRequest = { questionId: 'question-1', questions: [] }

function session(status: SessionStatus, permissionQueue: PermissionRequest[] = [], questionQueue: QuestionRequest[] = []): Session {
  return { status, permissionQueue, questionQueue, messages: [] } as unknown as Session
}

describe('the attention of an open tab', () => {
  test('a turn that connects is Starting, apart from one that runs', () => {
    // WHY: Starting draws the S backward with no clock; Running has a clock.
    expect(getAttentionState(session('connecting'), tab)).toBe('starting')
    expect(getAttentionState(session('running'), tab)).toBe('running')
  })

  test('a permission request that waits is Approval, a question is Input', () => {
    expect(getAttentionState(session('awaiting_input', [permission]), tab)).toBe('approval')
    expect(getAttentionState(session('awaiting_input', [], [question]), tab)).toBe('awaiting')
    // A tab knows no order between its two queues: a question beside a
    // permission request shows Input.
    expect(getAttentionState(session('awaiting_input', [permission], [question]), tab)).toBe('awaiting')
    // The status says a person must act even before the request arrives.
    expect(getAttentionState(session('awaiting_input'), tab)).toBe('awaiting')
  })

  test('an Approval row asks for the person, as an Input row does', () => {
    // WHY: a closed project folder must not hide a permission request.
    expect(needsAttention({ unread: false, status: 'approval' })).toBe(true)
    expect(needsAttention({ unread: false, status: 'question' })).toBe(true)
  })
})

describe('the dot mark of a live state', () => {
  test('a running turn draws its agent activity, and Working when none is known', () => {
    expect(liveDotMark('running', { activity: 'think' })).toBe('thinking')
    expect(liveDotMark('running', { activity: 'read' })).toBe('reading')
    expect(liveDotMark('running', { activity: 'edit' })).toBe('editing')
    expect(liveDotMark('running', { activity: 'run' })).toBe('running')
    expect(liveDotMark('running', { activity: 'search' })).toBe('searching')
    expect(liveDotMark('running', { activity: 'reply' })).toBe('writing')
    expect(liveDotMark('running', { activity: 'other' })).toBe('working')
    expect(liveDotMark('running')).toBe('working')
  })

  test('Starting and Background have their own marks, and every live state shows Offline when its host is away', () => {
    expect(liveDotMark('starting')).toBe('starting')
    expect(liveDotMark('background')).toBe('background')
    for (const state of ['starting', 'running', 'background'] as const) {
      expect(liveDotMark(state, { isHostOffline: true, activity: 'edit' })).toBe('offline')
    }
  })

  test('a state that is not live draws no dots, and its host being away changes nothing', () => {
    // WHY: dots move only while the agent works; a still glyph means a person
    // must act, or the turn is done.
    for (const state of ['awaiting', 'approval', 'awaiting_plan', 'limited', 'error', 'unread', null] as const) {
      expect(liveDotMark(state, { isHostOffline: true })).toBeNull()
      expect(getAttentionMark(state, { isHostOffline: true })?.kind ?? null).not.toBe('dot')
    }
  })

  test('Offline is muted, live work takes the one working colour every row uses', () => {
    expect(getAttentionMark('running', { isHostOffline: true })).toEqual({ kind: 'dot', mark: 'offline', color: 'var(--muted-foreground)' })
    expect(getAttentionMark('running', { activity: 'edit' })).toEqual({ kind: 'dot', mark: 'editing', color: 'var(--solus-status-working)' })
  })

  test('a host is unreachable once its link is down, not while it is first checked', () => {
    expect(isHostUnreachable('ready')).toBe(false)
    expect(isHostUnreachable('checking')).toBe(false)
    expect(isHostUnreachable(null)).toBe(false)
    for (const readiness of ['reconnecting', 'unreachable', 'refused', 'gone'] as const) {
      expect(isHostUnreachable(readiness)).toBe(true)
    }
  })
})

describe('the words of a state', () => {
  test('only Input, Approval, and Limited carry a word beside the glyph', () => {
    expect(glyphWord('question')).toBe('Input')
    expect(glyphWord('approval')).toBe('Approval')
    expect(glyphWord('limit')).toBe('Limited')
    expect(glyphWord('plan')).toBeNull()
    expect(glyphWord('error')).toBeNull()
    expect(glyphWord('finished')).toBeNull()
  })

  test('the full sentence names what the agent does and what waits', () => {
    // WHY: the row shows a mark or one word; the tooltip and aria-label keep
    // the sentence, so a screen reader hears the activity, not "Working".
    expect(attentionLabel('running', null, { activity: 'edit' })).toBe('the agent is editing files')
    expect(attentionLabel('running')).toBe('the agent is working')
    expect(attentionLabel('starting')).toBe('the agent is starting')
    expect(attentionLabel('approval')).not.toBe(attentionLabel('awaiting'))
    expect(attentionLabel('running', null, { isHostOffline: true })).toContain('offline')
    // A state that wants a person keeps its sentence when its host is away.
    expect(attentionLabel('approval', null, { isHostOffline: true })).toBe(attentionLabel('approval'))
  })
})
