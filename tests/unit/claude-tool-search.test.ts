import { describe, expect, test } from 'bun:test'
import { claudeToolSearchOverride } from '@solus/server/execution/agents/claude/claude-tool-search'

// Auto tool search sends every MCP schema in full under a share of the window, and a late MCP
// connect then misses the prompt cache. Only the auto modes Claude Code treats as "auto" are pinned on.
describe('claudeToolSearchOverride', () => {
  test('auto modes between on and off become true', () => {
    for (const value of ['auto', 'auto:10', 'auto:99.5', 'auto:x', 'auto:Infinity']) {
      expect(claudeToolSearchOverride(value), value).toBe('true')
    }
  })

  test('explicit choices, the auto modes that already mean on or off, and unset stay', () => {
    for (const value of [undefined, 'true', 'false', 'auto:0', 'auto:-5', 'auto:100', 'auto:1e2', 'auto:1_000', 'auto:1,000', 'AUTO']) {
      expect(claudeToolSearchOverride(value), String(value)).toBeUndefined()
    }
  })
})
