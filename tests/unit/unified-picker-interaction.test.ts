import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const picker = readFileSync(
  new URL(
    '../../packages/workspace-ui/src/components/session/unified-picker/UnifiedPicker.svelte',
    import.meta.url,
  ),
  'utf8',
)

const row = readFileSync(
  new URL(
    '../../packages/workspace-ui/src/components/session/unified-picker/UnifiedPickerRow.svelte',
    import.meta.url,
  ),
  'utf8',
)

describe('unified picker task disclosure', () => {
  test('clicking a task with sessions toggles it instead of resuming a session', () => {
    // WHY: a task row represents a disclosure group. Its first click reveals
    // the sessions and its next click must close the same group.
    expect(picker).toContain('function clickEntry(entry: PickerEntry)')
    expect(picker).toContain('if (toggleTaskEntry(entry)) return;')
    expect(picker).toContain('toggleTask(entry.task.id);')
    expect(picker).toContain('onActivate={clickEntry}')
    expect(row).toContain('aria-expanded={row.sessions.length ? row.expanded : undefined}')
  })

  test('Space expands the selected task while Enter keeps its activation action', () => {
    // WHY: Space is the keyboard equivalent of clicking the task group. Enter
    // remains available for the existing resume-or-draft action.
    expect(picker).toMatch(
      /event\.key === " " && selectedEntry\?\.kind === "task"[\s\S]*?expandTaskEntry\(selectedEntry\)/,
    )
    expect(picker).toMatch(
      /event\.key === "Enter" && selectedEntry[\s\S]*?activate\(selectedEntry\)/,
    )
    expect(picker).toContain('<Kbd variant="keycap">Space</Kbd> expand sessions')
  })

  test('hover selects a task without expanding it', () => {
    // WHY: hover is only a preview and cursor action. It must not change the
    // task tree before the user clicks or uses a disclosure key.
    expect(picker).toContain(
      'if (selectedIndex !== entry.entryIndex) selectIndex(entry.entryIndex);',
    )
    expect(picker).not.toContain('selectedTaskId')
  })
})
