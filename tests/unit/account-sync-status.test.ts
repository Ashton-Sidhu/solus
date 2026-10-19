import { describe, expect, test } from 'bun:test'
import { EMPTY_AGENT_PROFILE_STATUS } from '@solus/contracts/agent-profile'
import { accountSyncBadge, accountSyncTone } from '@solus/workspace-ui/components/settings/lib/sync-status'
import { agentProfileDescription } from '@solus/workspace-ui/components/seats/lib/agent-profile-copy'

/**
 * Settings → Account & sync shows the sync state as a badge. Only a confirmed
 * sync reads as settled: an optimistic edit, a check in flight, or a stop must
 * never wear the "Synced" colour (plans/018 §5).
 */

const summary = (state: Parameters<typeof accountSyncTone>[0]) => ({ state, pendingCount: 2, conflictCount: 1, error: null })

describe('account sync badge', () => {
  test('only a confirmed sync is settled', () => {
    expect(accountSyncTone('synced')).toBe('settled')
    expect(accountSyncTone('pending')).toBe('working')
    expect(accountSyncTone('loading')).toBe('working')
    expect(accountSyncBadge(summary('pending'))).not.toBe('Synced')
  })

  test('a state the person must act on asks for attention, and a refusal reads as stopped', () => {
    expect(accountSyncTone('conflict')).toBe('attention')
    expect(accountSyncTone('offline')).toBe('attention')
    expect(accountSyncTone('error')).toBe('stopped')
  })
})

describe('host row on Account & sync', () => {
  test('the line says what the host holds and where from, not what the profile is', () => {
    const status = { ...EMPTY_AGENT_PROFILE_STATUS, syncedAt: Date.now(), source: 'account' as const, counts: { files: 0, skills: 3, integrations: 1 } }
    const text = agentProfileDescription(status, undefined)
    expect(text).toStartWith('Pulled from your account')
    expect(text).toContain('3 skills, 1 MCP server')
    expect(text).not.toContain('subagents')
  })

  test('a host without the profile says so, and an error wins', () => {
    expect(agentProfileDescription(undefined, undefined)).toBe('Not on this host yet.')
    expect(agentProfileDescription(undefined, 'The host refused.')).toBe('The host refused.')
  })
})
