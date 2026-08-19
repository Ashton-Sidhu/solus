import { describe, expect, test } from 'bun:test'
import type { Automation } from '@solus/contracts/types'
import { automationMatchesProject } from '@solus/workspace-ui/components/project-panel/lib/automation-board'

const item: Automation = {
  id: 'automation-1',
  name: 'Same path',
  enabled: true,
  action: {
    prompt: 'Run checks',
    agentProvider: 'codex',
    modelId: null,
    reasoningEffort: 'medium',
    cwd: '/workspace/project',
  },
  trigger: { type: 'manual' },
  createdAt: '2026-08-09T00:00:00.000Z',
  updatedAt: '2026-08-09T00:00:00.000Z',
  createdBy: { kind: 'user' },
}

describe('project-panel automation host matching', () => {
  test('treats the same path on two hosts as different projects', () => {
    expect(
      automationMatchesProject(item, 'host-a', 'host-a', ['/workspace/project']),
    ).toBe(true)
    expect(
      automationMatchesProject(item, 'host-a', 'host-b', ['/workspace/project']),
    ).toBe(false)
  })
})
