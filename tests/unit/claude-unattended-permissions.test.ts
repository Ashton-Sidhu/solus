import { describe, expect, test } from 'bun:test'
import { PermissionManager } from '../../src/main/agents/claude/claude-permissions'

describe('Claude unattended permissions', () => {
  test.each(['AskUserQuestion', 'ExitPlanMode'])(
    'denies %s immediately instead of waiting for hidden UI',
    async (toolName) => {
      const manager = new PermissionManager()
      const events: unknown[] = []
      manager.onPermissionEvent = (_sessionId, event) => events.push(event)
      const canUseTool = manager.createCanUseTool({ current: null }, 'plan', true)

      const result = await canUseTool(toolName, {})

      expect(result.behavior).toBe('deny')
      expect(result.message).toContain('unattended')
      expect(events).toEqual([])
    },
  )
})
