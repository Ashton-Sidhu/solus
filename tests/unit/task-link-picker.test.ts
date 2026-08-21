import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const pickerSource = readFileSync(
  join(
    import.meta.dir,
    '../../packages/workspace-ui/src/components/tasks/task-page/TaskLinkPicker.svelte',
  ),
  'utf8',
)

describe('task link picker', () => {
  test('warms its reactive reference index only once per modal mount', () => {
    // WHY: warm reads and writes the candidate stores. Running it in a tracked
    // effect lets those store updates retrigger the effect until Svelte stops
    // the modal with an effect_update_depth_exceeded error.
    expect(pickerSource).toContain('onMount(() => {')
    expect(pickerSource).toContain('index.warm();')
    expect(pickerSource).not.toContain('$effect(')
  })

  test('uses distinct large-desktop and compact-laptop geometry', () => {
    // WHY: the shared responsive type rung is not enough for a modal. Its
    // width, height, padding, and rows must also fit each pointer-fine display.
    expect(pickerSource).toContain('w-[clamp(28rem,36vw,32rem)]')
    expect(pickerSource).toContain('max-h-[min(40rem,68svh)]')
    expect(pickerSource).toContain('pointer-fine:[.is-laptop-display_&]:w-[28rem]')
    expect(pickerSource).toContain('pointer-fine:[.is-laptop-display_&]:max-h-[60svh]')
    expect(pickerSource).toContain('max-w-[calc(100vw-1.5rem)]')
  })

  test('scales all modal text with the responsive workspace rung', () => {
    // WHY: text-workspace-chrome grows from laptop to large desktop. Fixed
    // text-xs descendants would stay at 12px and make metadata look undersized.
    expect(pickerSource).toContain('text-workspace-chrome')
    expect(pickerSource).not.toContain('text-xs')
    expect(pickerSource).toContain('text-[0.875em]')
  })
})
