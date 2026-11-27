import { describe, expect, test } from 'bun:test'
import { mcpRowIsOpen } from '@solus/workspace-ui/components/settings/lib/mcp-row-open'

describe('the open state of a server row on the MCP page', () => {
  test('a running sign-in opens the row, and the person can still close it', () => {
    // WHY: a sign-in can wait for a callback that never comes (a server that
    // refuses Solus's redirect URL); the collapse button must still work then.
    expect(mcpRowIsOpen({ isExpanded: false, isSignInRunning: true, isClosedByPerson: false })).toBe(true)
    expect(mcpRowIsOpen({ isExpanded: false, isSignInRunning: true, isClosedByPerson: true })).toBe(false)
    expect(mcpRowIsOpen({ isExpanded: true, isSignInRunning: false, isClosedByPerson: true })).toBe(true)
    expect(mcpRowIsOpen({ isExpanded: false, isSignInRunning: false, isClosedByPerson: false })).toBe(false)
  })
})
