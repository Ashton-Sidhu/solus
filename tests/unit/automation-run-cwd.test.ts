import { describe, expect, test } from 'bun:test'
import { automationRunCwd } from '../../src/renderer/components/automations/lib/automation-format'
import type { AutomationRun } from '../../src/shared/types'

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'automation-1',
    startedAt: '2026-07-18T12:00:00.000Z',
    status: 'succeeded',
    ...overrides,
  }
}

describe('automationRunCwd', () => {
  test('uses the persisted worktree path so the provider transcript can be found', () => {
    expect(automationRunCwd(
      run({ branch: 'solus/fix-session-abc12', worktreePath: '/repo/.solus-worktrees/custom-path' }),
      '/repo',
    )).toBe('/repo/.solus-worktrees/custom-path')
  })

  test('reconstructs the deterministic worktree path for older run records', () => {
    expect(automationRunCwd(
      run({ branch: 'solus/fix-session-abc12' }),
      '/repo',
    )).toBe('/repo/.solus-worktrees/solus-fix-session-abc12')
  })

  test('keeps the automation directory for runs without worktree isolation', () => {
    expect(automationRunCwd(run(), '/repo')).toBe('/repo')
  })
})
