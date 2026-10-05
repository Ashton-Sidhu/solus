import { describe, expect, test } from 'bun:test'
import type { SeatStatus } from '@solus/contracts/seats'
import { seatNeeded, seatNoticeShown } from '@solus/workspace-ui/contexts/seats/seat-need'

// A member of an organization runs each turn on their own seat. A draft or an
// open shared session says so before the send, never only after a refusal.

function seat(provider: SeatStatus['provider'], state: SeatStatus['state']): SeatStatus {
  return { provider, state, usageCapable: true }
}

describe('seat state before send (S7)', () => {
  test('a member with no seat for the chosen agent needs one', () => {
    expect(seatNeeded(true, [seat('claude-code', 'none'), seat('codex', 'connected')], 'claude-code')).toBe(true)
    expect(seatNeeded(true, [seat('claude-code', 'expired')], 'claude-code')).toBe(true)
    expect(seatNeeded(true, [], 'codex')).toBe(true)
  })

  test('a connected seat for the chosen agent needs nothing', () => {
    expect(seatNeeded(true, [seat('claude-code', 'none'), seat('codex', 'connected')], 'codex')).toBe(false)
  })

  test('a host that does not give this client seats never asks', () => {
    // WHY: the owner's turns run on the host login, and a personal host has no
    // seats at all; a "Connect" there would be a false alarm.
    expect(seatNeeded(false, [seat('claude-code', 'none')], 'claude-code')).toBe(false)
    expect(seatNeeded(undefined, undefined, 'claude-code')).toBe(false)
  })

  test('before the host lists the seats, the notice does not guess', () => {
    expect(seatNeeded(true, undefined, 'claude-code')).toBe(false)
  })
})

describe('seat notice in an open shared session (plan 004, item 9)', () => {
  const missing = [seat('claude-code', 'none')]

  test('a member with no seat learns before they send, not from the refusal', () => {
    expect(seatNoticeShown(true, missing, 'claude-code', false)).toBe(true)
  })

  test('while a turn runs the notice goes: a steer runs on the author\'s seat (D3)', () => {
    expect(seatNoticeShown(true, missing, 'claude-code', true)).toBe(false)
  })

  test('a connected seat for the session\'s agent needs nothing', () => {
    expect(seatNoticeShown(true, [seat('claude-code', 'connected')], 'claude-code', false)).toBe(false)
  })

  test('a host with no seats for this client never asks, as in the draft', () => {
    // WHY: the host owner's turns run on the host login; a "Connect" there is a false alarm.
    expect(seatNoticeShown(false, missing, 'claude-code', false)).toBe(false)
    expect(seatNoticeShown(undefined, undefined, 'claude-code', false)).toBe(false)
  })
})
