import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(
  new URL('../../packages/workspace-ui/src/components/session/TaskRow.svelte', import.meta.url),
  'utf8',
)

describe('session sidebar host context', () => {
  test('names a remote host without letting it displace the session state', () => {
    // WHY: an operating-system glyph cannot identify the machine from a remote
    // or SaaS client. The label must remain present, but bounded, in the narrow
    // sidebar line that also owns the session state and hover actions.
    expect(source).toContain('class="flex min-w-0 max-w-[45%] items-center gap-1"')
    expect(source).toContain('<span class="min-w-0 truncate">{host?.label}</span>')
  })

  test('uses the responsive chrome rung and reduces the host glyph on laptops', () => {
    // WHY: fixed `text-xs` stays at 12px on desktop, while a fixed 14px Apple
    // glyph is too prominent there. The shared rung grows the text to 14px on
    // desktop, and the explicit icon rung keeps the glyph subordinate on both.
    expect(source).toContain('text-workspace-chrome')
    expect(source).toContain('class="size-3 shrink-0 [.is-laptop-display_&]:size-2.5"')
  })
})
