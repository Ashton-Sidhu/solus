import { describe, expect, test } from 'bun:test'
import { toContextBreakdown } from '@solus/server/agents/claude/claude-context-usage'

describe('toContextBreakdown', () => {
  test('omits both halves when the CLI reports no breakdown', () => {
    // A CLI older than these fields must leave the meter on its totals rather
    // than render an empty "what's in the window" section.
    expect(toContextBreakdown({})).toEqual({})
  })

  test('drops categories that hold no window', () => {
    const { categories } = toContextBreakdown({
      categories: [
        { name: 'Messages', tokens: 40_000 },
        { name: 'Skills', tokens: 0 },
        { name: '   ', tokens: 500 },
      ],
    })
    expect(categories).toEqual([{ name: 'Messages', tokens: 40_000 }])
  })

  test('marks a deferred category so the meter can withhold a share', () => {
    const { categories } = toContextBreakdown({
      categories: [{ name: 'MCP tools (deferred)', tokens: 9_000, isDeferred: true }],
    })
    expect(categories?.[0]?.deferred).toBe(true)
  })

  test('strips the MCP wire prefix and keeps the server as the detail', () => {
    const { groups } = toContextBreakdown({
      mcpTools: [{ name: 'mcp__linear__create_issue', tokens: 800, serverName: 'linear' }],
    })
    expect(groups?.[0]?.items[0]).toEqual({
      name: 'create_issue',
      tokens: 800,
      detail: 'linear',
    })
  })

  test('leaves a tool name that is not in MCP wire format alone', () => {
    const { groups } = toContextBreakdown({ systemTools: [{ name: 'Bash', tokens: 300 }] })
    expect(groups?.[0]?.items[0]?.name).toBe('Bash')
  })

  test('shortens a memory path to the segments that identify it', () => {
    // The home prefix is what a narrow popover truncates, and it takes the
    // identifying part of the path with it.
    const { groups } = toContextBreakdown({
      memoryFiles: [{ path: '/Users/sidhu/solus/CLAUDE.md', tokens: 1_200, type: 'Project' }],
    })
    expect(groups?.[0]?.items[0]?.name).toBe('solus/CLAUDE.md')
  })

  test('orders items largest first, so the offender is the first row', () => {
    const { groups } = toContextBreakdown({
      systemTools: [
        { name: 'small', tokens: 10 },
        { name: 'huge', tokens: 9_000 },
        { name: 'middling', tokens: 400 },
      ],
    })
    expect(groups?.[0]?.items.map((i) => i.name)).toEqual(['huge', 'middling', 'small'])
  })

  test('a trimmed group still totals every item it stands for', () => {
    // Truncating the list must never understate the group, or the header would
    // disagree with the category row it is expanding.
    const many = Array.from({ length: 120 }, (_: unknown, i: number) => ({ name: `tool-${i}`, tokens: 100 }))
    const { groups } = toContextBreakdown({ systemTools: many })
    expect(groups?.[0]?.items).toHaveLength(50)
    expect(groups?.[0]?.tokens).toBe(12_000)
  })

  test('skips a group whose every item is empty rather than showing a blank row', () => {
    const { groups } = toContextBreakdown({
      systemTools: [{ name: 'unused', tokens: 0 }],
      agents: [{ agentType: 'reviewer', tokens: 700, source: 'projectSettings' }],
    })
    expect(groups?.map((g: { label: string }) => g.label)).toEqual(['Agents'])
  })
})
