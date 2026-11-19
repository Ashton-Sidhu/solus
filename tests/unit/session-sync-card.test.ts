import { describe, expect, test } from 'bun:test'
import type { SessionSyncFailure } from '@solus/contracts/rpc'
import type { StatusCardState } from '@solus/contracts/types'
import {
  isSessionSyncCard,
  sessionSyncCardView,
  sessionSyncFailureAction,
  sessionSyncFailureText,
} from '@solus/client-core/session-sync-card'

// The sync card a host publishes while it gets a session (portable-sessions
// §19, Part D) names steps and reasons by id. The person reads plain words.

const names = { sourceHost: 'Studio', runHost: 'Laptop', provider: 'Claude Code' }

/** Every reason the contract names. The record type makes a new reason fail to compile here. */
const REASONS: Record<SessionSyncFailure, true> = {
  'provider-unavailable': true, 'seat-required': true, 'model-unavailable': true, 'provider-too-old': true,
  'source-offline': true, 'no-repository': true, 'no-project-checkout': true, diverged: true,
  'code-restore': true, 'thread-conflict': true, interrupted: true, failed: true,
}

function card(fields: Partial<StatusCardState> = {}): StatusCardState {
  return {
    id: 'session-sync-s1',
    title: 'Syncing from 1234-installation…',
    icon: 'server',
    status: 'active',
    steps: ['fetch', 'preflight', 'checkout', 'thread', 'records'].map((id) => ({ id, label: id, status: 'pending' as const })),
    ...fields,
  }
}

describe('a failed sync', () => {
  test('each reason has a plain text and an action', () => {
    // WHY: a failure with no words leaves the person with a dead card.
    for (const reason of Object.keys(REASONS) as SessionSyncFailure[]) {
      const text = sessionSyncFailureText(reason, names)
      expect(text.message.length).toBeGreaterThan(10)
      expect(text.message).not.toContain(reason)
      expect(text.action).toBe(sessionSyncFailureAction(reason))
    }
  })

  test('a missing seat offers the connect flow, an offline source names it and offers Run on', () => {
    expect(sessionSyncFailureText('seat-required', names).action).toBe('connect-seat')
    expect(sessionSyncFailureText('source-offline', names)).toEqual({ message: expect.stringContaining('Studio is offline'), action: 'choose-host' })
    expect(sessionSyncFailureText('no-project-checkout', names).message).toContain('Laptop has no copy of this project')
  })
})

describe('the card as the client shows it', () => {
  test('the five steps read as plain labels and the title names the source host, not its id', () => {
    const shown = sessionSyncCardView(card(), names)
    expect(shown.title).toBe('Syncing from Studio')
    expect(shown.steps.map((step) => step.label)).toEqual([
      'Getting the session from Studio',
      'Checking Claude Code',
      'Preparing the code',
      'Restoring the conversation',
      'Finishing',
    ])
  })

  test('the failed step says why; the host words stay as output', () => {
    const failed = card({ status: 'error', syncFailureReason: 'source-offline', steps: [{ id: 'fetch', label: 'fetch', status: 'error', detail: 'socket closed' }] })
    const shown = sessionSyncCardView(failed, names)
    expect(shown.title).toBe('Could not sync to Laptop')
    expect(shown.steps[0]!.detail).toContain('Studio is offline')
    expect(shown.output).toEqual(['socket closed'])
  })

  test('another card is unchanged', () => {
    // WHY: the Run on setup card and the worktree card keep their own words.
    const setup = card({ id: 'remote-dispatch-tab-1' })
    expect(sessionSyncCardView(setup, names)).toBe(setup)
    expect(isSessionSyncCard(setup)).toBe(false)
    expect(isSessionSyncCard(card(), 's1')).toBe(true)
    expect(isSessionSyncCard(card(), 's2')).toBe(false)
  })
})
