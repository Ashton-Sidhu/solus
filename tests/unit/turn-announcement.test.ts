import { describe, expect, test } from 'bun:test'
import { TurnAnnouncer, turnPhaseFor, type TurnPhase } from '@solus/client-core/turn-announcement'

/** What each observation speaks, and the live region text after it. */
function play(announcer: TurnAnnouncer, steps: Array<[string, TurnPhase | null]>): Array<[TurnPhase | null, string]> {
  return steps.map(([conversationId, phase]) => [announcer.observe(conversationId, phase), announcer.text])
}

/** A screen reader hears a turn change phase, but never a phase it only came upon. */
describe('turn announcements', () => {
  test('names each phase a turn moves through', () => {
    expect(turnPhaseFor('running', false)).toBe('Working')
    expect(turnPhaseFor('awaiting_input', true)).toBe('Needs approval')
    expect(turnPhaseFor('awaiting_plan', false)).toBe('Needs approval')
    expect(turnPhaseFor('awaiting_input', false)).toBe('Needs your input')
    expect(turnPhaseFor('completed', false)).toBe('Done')
    expect(turnPhaseFor('failed', false)).toBe('Failed')
    expect(turnPhaseFor('interrupted', false)).toBe('Stopped')
    expect(turnPhaseFor('idle', false)).toBeNull()
  })

  test('the first phase is the baseline; later changes are spoken', () => {
    expect(play(new TurnAnnouncer(), [
      ['tab-a', 'Done'],
      ['tab-a', 'Working'],
      ['tab-a', 'Needs approval'],
      ['tab-a', 'Working'],
      ['tab-a', 'Done'],
    ])).toEqual([
      [null, ''],
      ['Working', 'Working'],
      ['Needs approval', 'Needs approval'],
      ['Working', 'Working'],
      ['Done', 'Done'],
    ])
  })

  test('a conversation that loads with no phase takes its first phase as the baseline', () => {
    expect(play(new TurnAnnouncer(), [
      ['tab-a', null],
      ['tab-a', 'Working'],
      ['tab-a', 'Failed'],
    ])).toEqual([
      [null, ''],
      [null, ''],
      ['Failed', 'Failed'],
    ])
  })

  test('switching conversation clears the region without speaking', () => {
    expect(play(new TurnAnnouncer(), [
      ['tab-a', 'Working'],
      ['tab-a', 'Done'],
      ['tab-b', 'Working'],
      ['tab-b', 'Stopped'],
    ])).toEqual([
      [null, ''],
      ['Done', 'Done'],
      [null, ''],
      ['Stopped', 'Stopped'],
    ])
  })

  test('a repeated or unnamed status is silent and keeps the region as it is', () => {
    expect(play(new TurnAnnouncer(), [
      ['tab-a', 'Done'],
      ['tab-a', 'Working'],
      ['tab-a', 'Working'],
      ['tab-a', null],
    ])).toEqual([
      [null, ''],
      ['Working', 'Working'],
      [null, 'Working'],
      [null, 'Working'],
    ])
  })
})
