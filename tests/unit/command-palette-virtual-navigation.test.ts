import { describe, expect, test } from 'bun:test'
import {
  visibleCommandEdge,
  type CommandDisplayRow,
} from '../../src/renderer/components/command-palette/lib/commands'

const rows: CommandDisplayRow[] = [
  { kind: 'header', title: 'Commands' },
  ...Array.from({ length: 10 }, (_, commandIndex) => ({
    kind: 'command' as const,
    commandIndex,
    cmd: {
      id: `command-${commandIndex}`,
      label: `Command ${commandIndex}`,
      group: 'Commands',
    },
  })),
]

describe('visibleCommandEdge', () => {
  test('adopts the visible edge instead of jumping to an off-screen selection', () => {
    // The user has scrolled commands 0–3 away while selection stayed at 0.
    const scrollOffset = 28 + 4 * 36

    expect(visibleCommandEdge(rows, 0, scrollOffset, 3 * 36, 28, 36, 1)).toBe(4)
    expect(visibleCommandEdge(rows, 0, scrollOffset, 3 * 36, 28, 36, -1)).toBe(6)
  })

  test('keeps normal relative navigation while selection is visible', () => {
    const scrollOffset = 28 + 4 * 36

    expect(visibleCommandEdge(rows, 5, scrollOffset, 3 * 36, 28, 36, 1)).toBeNull()
  })
})
