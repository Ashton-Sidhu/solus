import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'bun:test'

const source = readFileSync(
  join(import.meta.dir, '../../src/renderer/components/layout/StatusBarControls.svelte'),
  'utf8',
)

test('status bar uses the compact desktop chrome type rung', () => {
  // WHY: Laptop and desktop status controls must stay compact without reducing
  // the touch-readable label size on coarse-pointer mobile clients.
  expect(source).toContain(
    'class="relative flex min-w-0 items-center gap-2 text-workspace-chrome"',
  )
})
