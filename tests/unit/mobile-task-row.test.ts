import { describe, expect, it } from 'bun:test'
import type { SidebarTask } from '@solus/workspace-ui/components/session/lib/task-list'
import {
  MOBILE_STATE_INK,
  mobileRowTimestamp,
  mobileSessionCount,
  mobileSessionState,
  mobileSnoozeWake,
  mobileTaskState,
} from '../../apps/client/src/lib/mobile-task-row'

/**
 * A mobile row draws its state as a glyph, the way the desktop sidebar does,
 * and names it in words only for the accessible label. These tests pin both,
 * because the glyph is now the only thing on the row that reports lifecycle —
 * get it wrong and a snoozed task reads as work in flight, silently.
 */

function row(overrides: Partial<SidebarTask>): Pick<SidebarTask, 'lifecycle' | 'status'> {
  return { lifecycle: 'active', status: 'idle', ...overrides }
}

describe('mobileTaskState', () => {
  it('lets the user’s own verdict outrank whatever the last run did', () => {
    // A completed task whose newest session died still reads "completed": the
    // person said they were finished with it, and that is the row's answer.
    expect(mobileTaskState(row({ lifecycle: 'completed', status: 'error' }))).toEqual({
      glyph: 'completed',
      label: 'completed',
      tone: 'success',
    })
    expect(mobileTaskState(row({ lifecycle: 'snoozed', status: 'running' }))).toEqual({
      glyph: 'snoozed',
      label: 'snoozed',
      tone: 'warning',
    })
    // The check the user ticked means the same thing as a completed lifecycle,
    // so it draws the same mark rather than a second one.
    expect(mobileTaskState(row({ status: 'done' })).glyph).toBe('completed')
  })

  it('reports the run only while the task is active', () => {
    expect(mobileTaskState(row({ status: 'running' }))).toEqual({
      glyph: 'running',
      label: 'running',
      tone: 'running',
    })
    expect(mobileTaskState(row({ status: 'error' }))).toEqual({
      glyph: 'failure',
      label: 'failed',
      tone: 'failure',
    })
  })

  it('keeps unread behind any state that wants a person', () => {
    // Unread is what a finished row has left to say. A row that is asking a
    // question is also unread, and the question is the more specific fact.
    expect(mobileTaskState({ ...row({ status: 'idle' }), unread: true }).glyph).toBe('unread')
    expect(mobileTaskState({ ...row({ status: 'question' }), unread: true }).glyph).toBe('question')
  })

  it('says nothing for a task that is simply sitting there', () => {
    // "idle" is not news, so the row's accessible name is just its title.
    expect(mobileTaskState(row({ status: 'idle' }))).toEqual({
      glyph: 'idle',
      label: '',
      tone: 'muted',
    })
  })

  it('gives every state its own mark and a colour that resolves', () => {
    // No two states may share a silhouette: the glyph is the whole report now,
    // so a collision makes one state unreadable rather than merely terse.
    const glyphs = new Set<string>()
    for (const status of ['running', 'error', 'question', 'plan', 'limit', 'idle'] as const) {
      const state = mobileTaskState(row({ status }))
      expect(MOBILE_STATE_INK[state.tone]).toBeTruthy()
      glyphs.add(state.glyph)
    }
    for (const lifecycle of ['snoozed', 'completed'] as const) {
      glyphs.add(mobileTaskState(row({ lifecycle })).glyph)
    }
    glyphs.add(mobileTaskState({ ...row({ status: 'idle' }), unread: true }).glyph)
    expect(glyphs.size).toBe(9)
  })
})

describe('mobileSessionState', () => {
  it('reads a run without a lifecycle of its own', () => {
    // A session is one turn, not a durable task, so it can never say
    // "completed" or "snoozed" — only what the turn is doing.
    expect(mobileSessionState('running')).toEqual({
      glyph: 'running',
      label: 'running',
      tone: 'running',
    })
    expect(mobileSessionState('awaiting').glyph).toBe('question')
    expect(mobileSessionState('awaiting_plan').glyph).toBe('plan')
    expect(mobileSessionState('queued').glyph).toBe('limit')
    expect(mobileSessionState('error').glyph).toBe('failure')
    expect(mobileSessionState('unread').glyph).toBe('unread')
    expect(mobileSessionState(null)).toEqual({ glyph: 'idle', label: '', tone: 'muted' })
  })
})

describe('mobileRowTimestamp', () => {
  const now = new Date('2026-08-26T15:18:00').getTime()

  it('gives the time within the day and the date beyond it', () => {
    expect(mobileRowTimestamp(new Date('2026-08-26T14:02:00').getTime(), now)).toBe('14:02')
    expect(mobileRowTimestamp(new Date('2026-08-16T09:00:00').getTime(), now)).toMatch(/Aug/)
  })

  it('adds the year only once it stops being this one', () => {
    // Two tokens wide for an ordinary row; a row from last August has to say
    // which August it means.
    expect(mobileRowTimestamp(new Date('2026-08-16T09:00:00').getTime(), now)).not.toMatch(/2026|2025/)
    expect(mobileRowTimestamp(new Date('2025-08-16T09:00:00').getTime(), now)).toMatch(/2025/)
  })

  it('prints nothing rather than the epoch for a row with no activity', () => {
    expect(mobileRowTimestamp(0, now)).toBe('')
  })
})

describe('mobileSnoozeWake', () => {
  const now = new Date('2026-08-26T15:18:00').getTime()

  it('names the day when the wake time is not today', () => {
    expect(mobileSnoozeWake(new Date('2026-08-27T09:00:00').getTime(), now)).toMatch(/^wakes tomorrow/)
    expect(mobileSnoozeWake(new Date('2026-08-26T18:00:00').getTime(), now)).toMatch(/^wakes (?!tomorrow)/)
    expect(mobileSnoozeWake(new Date('2026-08-29T09:00:00').getTime(), now)).toMatch(/^wakes \w{3} /)
  })

  it('says nothing when there is no wake time', () => {
    expect(mobileSnoozeWake(0, now)).toBe('')
  })
})

describe('mobileSessionCount', () => {
  it('earns its place on the row only past one run', () => {
    // "1 session" on every row is noise: a task with one run *is* that run.
    expect(mobileSessionCount(1)).toBe('')
    expect(mobileSessionCount(0)).toBe('')
    expect(mobileSessionCount(3)).toBe('3 sessions')
  })
})
