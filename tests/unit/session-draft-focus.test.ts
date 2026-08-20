import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const draftPane = readFileSync(
  join(
    import.meta.dir,
    '../../packages/workspace-ui/src/components/session-draft/SessionDraftPane.svelte',
  ),
  'utf8',
)

describe('session draft composer focus', () => {
  test('claims focus after the routed composer is visible and its picker closes', () => {
    // WHY: the previous conversation input stays mounted behind a draft. Its
    // active editor must not prevent the newly opened draft from getting the
    // caret, including when the draft was opened from the session picker.
    expect(draftPane).toContain('surfaceVisible = true')
    expect(draftPane).toMatch(
      /\$effect\(\(\) => \{[\s\S]*if \(!surfaceVisible \|\| !draft \|\| session\.sessionPickerOpen\) return;[\s\S]*requestAnimationFrame\(\(\) => \{[\s\S]*requestInputFocus\(\)/,
    )
    expect(draftPane).toContain('cancelAnimationFrame(focusFrame)')
  })
})
