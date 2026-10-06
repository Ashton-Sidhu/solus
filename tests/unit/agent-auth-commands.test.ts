import { describe, expect, test } from 'bun:test'
import { parseAgentAuthCommand } from '@solus/contracts/agent-auth'

// docs/plans/agent-auth-commands.md: the provider CLIs keep their sign-ins for a
// terminal, so Solus runs these itself. Anything else, plain `/mcp` included, must
// still reach the agent.

describe('parseAgentAuthCommand', () => {
  test('the sign-in commands are Solus commands for both agents', () => {
    expect(parseAgentAuthCommand('/login', 'codex')).toEqual({ kind: 'login', provider: 'codex' })
    expect(parseAgentAuthCommand(' /mcp login  sentry ', 'claude-code')).toEqual({ kind: 'mcp-login', provider: 'claude-code', server: 'sentry' })
    expect(parseAgentAuthCommand('/mcp logout sentry', 'codex')).toEqual({ kind: 'mcp-logout', provider: 'codex', server: 'sentry' })
    expect(parseAgentAuthCommand('/mcp login', 'codex')).toEqual({ kind: 'mcp-login', provider: 'codex', server: null })
  })

  test('Claude Design is a Claude sign-in only', () => {
    expect(parseAgentAuthCommand('/design-login', 'claude-code')).toEqual({ kind: 'design-login' })
    expect(parseAgentAuthCommand('/design-login', 'codex')).toBeNull()
  })

  test('the agent keeps every other command, and prose that starts with one', () => {
    for (const text of ['/mcp', '/mcp reconnect sentry', '/login please help', '/mcp login a b', '/logout', 'how does /login work?']) {
      expect(parseAgentAuthCommand(text, 'claude-code')).toBeNull()
    }
    expect(parseAgentAuthCommand('/login', null)).toBeNull()
  })
})
