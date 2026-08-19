import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const readRendererSource = (path: string) =>
  readFileSync(join(import.meta.dir, '../../packages/workspace-ui/src/components', path), 'utf8')

describe('draft hero project', () => {
  test('the headline project opens the chip list rather than naming it inertly', () => {
    // WHY: the hero draws the project underlined beside its favicon, which reads
    // as a target on every other surface. It must be a real control, and it must
    // drive the chip's own menu so the draft never offers two project lists.
    const pane = readRendererSource('session-draft/SessionDraftPane.svelte')
    expect(pane).toContain('onclick={() => (projectPickerOpen = true)}')
    expect(pane).toContain('aria-expanded={projectPickerOpen}')
    expect(pane).toContain('bind:projectPickerOpen')

    const header = readRendererSource('input/InputBarHeader.svelte')
    expect(header).toContain('bind:open={projectPickerOpen}')
  })

  test('the project list loads whenever the menu opens, not only on chip clicks', () => {
    // WHY: opening from the headline sets the chip's state without touching its
    // trigger. Loading recents from a trigger-only handler would open an empty
    // list, so the load hangs off the open state itself.
    const chip = readRendererSource('input/ProjectChip.svelte')
    expect(chip).toContain('open = $bindable(false)')
    expect(chip).not.toContain('onOpenChange')
    expect(chip).toMatch(/\$effect\(\(\) => \{\s*if \(!open\) return;[\s\S]*loadRecents\(\)/)
  })
})
