import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { callerFields, claudeParentToolUseId } from '@solus/server/agents/claude/claude-tool-adapter'

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

// WHY: the Claude SDK validates a call against the shape we give it before our
// own parse runs. A field with a default was offered as required there, so a
// call that left `report` or `wait_seconds` out of start_session was refused
// before Solus saw it. The caller's shape lets it be left out; our own parse
// still fills the default in.
describe('the fields Claude validates a call against', () => {
  test('lets a field with a default be left out, and our parse still fills it', () => {
    const fields = { prompt: z.string(), report: z.boolean().default(true), wait_seconds: z.number().default(0) }
    expect(z.object(fields).safeParse({ prompt: 'go' }).success).toBe(true)
    const caller = z.object(callerFields(fields))
    expect(caller.safeParse({ prompt: 'go' }).success).toBe(true)
    // Required fields stay required, and a wrong type is still refused.
    expect(caller.safeParse({}).success).toBe(false)
    expect(caller.safeParse({ prompt: 'go', report: 'yes' }).success).toBe(false)
    expect(z.object(fields).parse({ prompt: 'go' })).toEqual({ prompt: 'go', report: true, wait_seconds: 0 })
  })
})
