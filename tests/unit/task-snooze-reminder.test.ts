import { describe, expect, test } from 'bun:test'
import type { Task } from '@solus/contracts/task-types'
import {
  resolveTaskSnoozeReminder,
  sessionSnoozeReminder,
} from '@solus/workspace-ui/contexts/tasks/task-snooze'

function lookup(links: Record<string, Pick<Task, 'snoozedUntil'>>) {
  return {
    taskForSession: (sessionId: string | null | undefined) =>
      (sessionId ? links[sessionId] : null) ?? null,
  }
}

describe('task snooze reminder', () => {
  test('shows a generic conversation reminder when the optional note is empty', () => {
    // WHY: ending a snooze must create visible conversation content even when
    // the user chose a wake time without writing a reminder note.
    expect(resolveTaskSnoozeReminder({ snoozedUntil: 999 }, 1_000)).toEqual({
      detail: 'Ready to continue',
      wokeAt: 999,
    })
  })

  test('does not show the reminder before the wake time', () => {
    expect(resolveTaskSnoozeReminder({ snoozedUntil: 1_001 }, 1_000)).toBeNull()
  })

  test('uses the saved reminder note after the wake time', () => {
    expect(resolveTaskSnoozeReminder({
      snoozedUntil: 999,
      snoozeNote: '  Check the canary  ',
    }, 1_000)).toEqual({
      detail: 'Check the canary',
      wokeAt: 999,
    })
  })

  test('finds the woken task through the durable Solus session id', () => {
    // WHY: a task links to the Solus session id, not the provider-native one.
    // Reading only `agentSessionId` found no task for an ordinary session, so
    // the conversation showed nothing when a snooze reached its wake time.
    const session = { id: 'solus-1', handoffId: undefined, agentSessionId: 'provider-1' }
    expect(sessionSnoozeReminder(session, lookup({ 'solus-1': { snoozedUntil: 999 } }), 1_000))
      .toEqual({ detail: 'Ready to continue', wokeAt: 999 })
  })

  test('prefers the handoff identity, which owns the task across provider threads', () => {
    const session = { id: 'solus-1', handoffId: 'handoff-1', agentSessionId: 'provider-1' }
    expect(sessionSnoozeReminder(session, lookup({ 'handoff-1': { snoozedUntil: 999 } }), 1_000))
      .toEqual({ detail: 'Ready to continue', wokeAt: 999 })
  })

  test('still answers for a link recorded under the provider-native id', () => {
    // WHY: links written before the durable identity existed must keep working.
    const session = { id: 'solus-1', handoffId: undefined, agentSessionId: 'provider-1' }
    expect(sessionSnoozeReminder(session, lookup({ 'provider-1': { snoozedUntil: 999 } }), 1_000))
      .toEqual({ detail: 'Ready to continue', wokeAt: 999 })
  })
})
