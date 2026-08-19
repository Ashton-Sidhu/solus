import { describe, expect, test } from 'bun:test'
import { claudeParentToolUseId } from '@solus/server/agents/claude/claude-tool-adapter'

describe('claudeParentToolUseId', () => {
  test('recovers the streamed tool-use id from the MCP request _meta', () => {
    expect(claudeParentToolUseId({ _meta: { 'claudecode/toolUseId': 'toolu_123' } })).toBe('toolu_123')
  })

  test('degrades to undefined — never throws or blocks — when the CLI omits the id', () => {
    // The meta key is an undocumented CLI internal. If a future CLI drops or
    // renames it, tool execution must proceed (cards just lose nesting).
    expect(claudeParentToolUseId(undefined)).toBeUndefined()
    expect(claudeParentToolUseId({})).toBeUndefined()
    expect(claudeParentToolUseId({ _meta: {} })).toBeUndefined()
    expect(claudeParentToolUseId({ _meta: { 'claudecode/toolUseId': '' } })).toBeUndefined()
    expect(claudeParentToolUseId({ _meta: { 'claudecode/toolUseId': 42 } })).toBeUndefined()
  })
})
