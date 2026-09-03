import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const picker = readFileSync(
  new URL(
    '../../packages/workspace-ui/src/components/session/unified-picker/UnifiedPicker.svelte',
    import.meta.url,
  ),
  'utf8',
)

describe('unified picker scrolling', () => {
  test('manual scrolling does not retain an imperative selection target', () => {
    // WHY: the virtual list reapplies a numeric scroll target whenever live
    // session data changes its row-size input. A persistent target therefore
    // snaps a reader back to an earlier selected row after manual scrolling.
    expect(picker).toContain('let scrollTargetIndex = $state<number | undefined>(undefined)')
    expect(picker).toMatch(
      /scrollTargetIndex = Math\.max\([\s\S]*?await tick\(\);[\s\S]*?scrollTargetIndex = undefined/,
    )
    expect(picker).not.toContain('const scrollTargetIndex = $derived')
  })

  test('keyboard navigation still requests that selection be visible', () => {
    // WHY: removing the persistent target must not make arrow navigation move
    // the selection outside the visible virtual-list window.
    expect(picker).toContain('selectIndex(selectedIndex + 1, true)')
    expect(picker).toContain('selectIndex(selectedIndex - 1, true)')
    expect(picker).toContain('selectIndex(target.entryIndex, true)')
  })
})
