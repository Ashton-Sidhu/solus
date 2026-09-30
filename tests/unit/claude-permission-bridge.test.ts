import { describe, expect, test } from 'bun:test'
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import type { NormalizedEvent } from '@solus/contracts/types'
import { PermissionManager, sessionPermissionUpdates } from '@solus/server/execution/agents/claude/claude-permissions'
import { UI_TO_SDK_PERMISSION_MODE } from '@solus/server/execution/agents/claude/claude-agent'

function bridge() {
  const manager = new PermissionManager()
  const events: NormalizedEvent[] = []
  manager.onPermissionEvent = (_sessionId, event) => events.push(event)
  const canUseTool = manager.createCanUseTool({ current: 'session-1' })
  const ask = (toolName: string, input: Record<string, unknown>, suggestions?: PermissionUpdate[]) =>
    canUseTool(toolName, input, { signal: new AbortController().signal, toolUseID: 'tool-1', requestId: 'request-1', suggestions })
  const request = () => {
    const event = events.at(-1)
    if (event?.type !== 'permission_request') throw new Error('no permission request')
    return event
  }
  return { manager, ask, request }
}

describe('Claude permission bridge', () => {
  test('full access is the SDK bypass mode', () => {
    // WHY: full access must not depend on a Solus callback allowing each call.
    expect(UI_TO_SDK_PERMISSION_MODE['full-access']).toBe('bypassPermissions')
    expect(UI_TO_SDK_PERMISSION_MODE.supervised).toBe('default')
  })

  test('shows every call the SDK asks about, with no rules of its own', async () => {
    const { manager, ask, request } = bridge()

    const result = ask('Bash', { command: 'ls' })

    // WHY: the SDK already applied the mode and the user's settings before it
    // called us. A second, Solus-only allow list is what this change removed.
    expect(request().toolName).toBe('Bash')
    manager.respondToPermission(request().questionId, 'deny')
    expect(await result).toMatchObject({ behavior: 'deny' })
  })

  test('allow for session writes the SDK suggestion to the session, never to settings', async () => {
    const { manager, ask, request } = bridge()
    const suggestion: PermissionUpdate = {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
      behavior: 'allow',
      destination: 'localSettings',
    }

    const result = ask('Bash', { command: 'npm test' }, [suggestion])
    manager.respondToPermission(request().questionId, 'allow-session')

    expect(await result).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'npm test' },
      updatedPermissions: [{ ...suggestion, destination: 'session' }],
    })
  })

  test('Bash with no suggestion offers no session allow', async () => {
    const { ask, request } = bridge()

    void ask('Bash', { command: 'rm -rf build' })

    // WHY: a rule for the bare tool name would allow every command.
    expect(sessionPermissionUpdates('Bash', undefined)).toBeNull()
    expect(request().options.map((option) => option.id)).toEqual(['allow', 'deny'])
  })

  test('another tool with no suggestion allows that tool for the session', () => {
    expect(sessionPermissionUpdates('mcp__github__create_issue', [])).toEqual([
      { type: 'addRules', rules: [{ toolName: 'mcp__github__create_issue' }], behavior: 'allow', destination: 'session' },
    ])
  })
})
