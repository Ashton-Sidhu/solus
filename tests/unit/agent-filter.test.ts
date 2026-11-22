import { describe, expect, test } from 'bun:test'
import type { TreeSessionRow } from '@solus/client-core/session-tree'
import { agentFilterOptions, steppedOption } from '@solus/workspace-ui/components/session/artifacts/lib/agent-filter'

/**
 * The agent filter on the Threads surface and the changed-files card
 * (docs/plans/session-digests.md): All, This session, then each session started.
 */

function row(sessionId: string, extra: Partial<TreeSessionRow> = {}): TreeSessionRow {
  return {
    sessionId, title: `Session ${sessionId}`, provider: 'codex', status: 'idle', isRunning: false, isRemote: false,
    workedMs: 0, lastReply: null, changes: null, artifactCount: 0, descendantCount: 0, ...extra,
  }
}

describe('agent filter', () => {
  test('a session that started no agents shows no filter', () => {
    expect(agentFilterOptions('lead', [])).toEqual([])
  })

  test('the chips are All, This session, then each session started, with its state', () => {
    const options = agentFilterOptions('lead', [row('a', { isRunning: true }), row('b', { isRemote: true })])
    expect(options.map((option) => [option.scope, option.label, option.state, option.isRemote])).toEqual([
      ['all', 'All', null, false],
      ['lead', 'This session', null, false],
      ['a', 'Session a', 'running', false],
      ['b', 'Session b', 'done', true],
    ])
  })

  test('Left and Right step through the chips and wrap at the ends', () => {
    const options = agentFilterOptions('lead', [row('a')])
    expect(steppedOption(options, 'all', 1)?.scope).toBe('lead')
    expect(steppedOption(options, 'all', -1)?.scope).toBe('a')
    expect(steppedOption(options, 'a', 1)?.scope).toBe('all')
  })
})
