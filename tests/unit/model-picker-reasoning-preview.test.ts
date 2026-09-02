import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// The Reasoning column tracks the model under the cursor: sweep the model
// column, cross the divider, and the levels on offer are the previewed model's,
// not the current one's. bits-ui drops a row's highlight the moment the cursor
// leaves it, so nothing in the model column said which model a level was for.
// The model row now keeps its wash while its levels are on offer — the way a
// parent row stays lit while the cursor is in its submenu.

const UI = new URL('../../packages/workspace-ui/src/', import.meta.url).pathname
const picker = readFileSync(`${UI}components/pickers/SessionChip.svelte`, 'utf8')
const sheet = readFileSync(`${UI}index.css`, 'utf8')

const modelRowStart = picker.indexOf('data-picker-column="model"')
const modelRow = picker.slice(
  picker.lastIndexOf('<DropdownMenu.RadioItem', modelRowStart),
  picker.indexOf('</DropdownMenu.RadioItem>', modelRowStart),
)

const menuRow = sheet.slice(sheet.indexOf('@utility menu-row {'), sheet.indexOf('@utility tap-area'))

describe('model picker: which model a reasoning level belongs to', () => {
  test('the model row stays lit while its levels are on offer', () => {
    // WHY: the preview hook has to outlive the hover, or the cue is gone by
    // the time the cursor reaches a level.
    expect(modelRow).toContain('data-menu-preview={previewedModelId === model.id')
    expect(menuRow).toContain('&[data-menu-preview]')
  })

  test('the preview follows the cursor into the column, not just across it', () => {
    // WHY: a cursor that enters the Reasoning column straight from outside
    // never hovered a model. Its levels are the current model's, and that row
    // has to light up too or the cue only works for one of the two routes in.
    expect(picker).toContain('hoveredModelId ?? (hoveredLevel !== null ? currentModelId : null)')
  })

  test('the footer names the previewed model, never only the committed one', () => {
    // WHY: with the heading silent, the footer is the one place the pair is
    // spelled out. It has to read the same preview the row wash does.
    expect(picker).toContain('summary="{previewedModelLabel} ·')
  })
})
