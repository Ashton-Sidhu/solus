import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// The model picker is a menu, and a menu is a decision surface: `--text-menu`
// holds 14px on a laptop where `--text-workspace-chrome` steps to 12px (see the
// note in the `html.is-laptop-display` block in `index.css`). The picker used to
// pin the chrome rung on its content *and* restate it over every `.menu-row`,
// which made it the one menu in the app that shrank on a laptop display — a
// rung below the menus it opens beside.

const UI = new URL('../../packages/workspace-ui/src/', import.meta.url).pathname
const picker = readFileSync(`${UI}components/pickers/SessionChip.svelte`, 'utf8')

const menuContent = picker.slice(
  picker.indexOf('<DropdownMenu.Content'),
  picker.indexOf('</DropdownMenu.Content>'),
)

describe('model picker typography', () => {
  test('the menu takes the menu rung, not the chrome rung', () => {
    // WHY: the trigger chip is chrome and stays on the chrome rung — it sits in
    // a control row. What drops out of it is a menu, and it has to read like
    // every other menu at every display size.
    expect(menuContent).toContain('text-menu')
    expect(menuContent).not.toContain('text-workspace-chrome')
  })

  test('the menu does not restate a size over its rows', () => {
    // WHY: `menuRowVariants` already puts every row in the app on `text-menu`.
    // An override here silently de-tunes only this menu, and only on a laptop,
    // which is exactly how the defect survived.
    expect(menuContent).not.toContain('[&_.menu-row]:text-')
  })

  test('the fast mode row is built to the same rung as a real menu row', () => {
    // WHY: this row is hand-built rather than a `DropdownMenu` item, so nothing
    // gives it the row shape for free. It has to carry the rung and the laptop
    // height step itself or it stands out of the column it sits in.
    const fastModeLabel = picker.indexOf('>Fast mode</span>')
    const fastModeRow = picker.slice(picker.lastIndexOf('<div class=', fastModeLabel))
    const row = fastModeRow.slice(0, fastModeRow.indexOf('</div>'))

    expect(row).toContain('text-menu')
    expect(row).not.toContain('text-workspace-chrome')
    expect(row).toContain('pointer-fine:[.is-laptop-display_&]:h-7')
  })

  test('the trigger chip stays chrome', () => {
    // WHY: the two halves take different rungs on purpose. If a later change
    // "makes the picker consistent" by moving the trigger to `text-menu` too,
    // the chip grows out of the control row it shares with the mic and send.
    const trigger = picker.slice(
      picker.indexOf('<DropdownMenu.Trigger'),
      picker.indexOf('</DropdownMenu.Trigger>'),
    )
    expect(trigger).toContain('text-workspace-chrome')
  })
})
