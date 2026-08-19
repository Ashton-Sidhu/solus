import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const activityRow = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/conversation/ActivityRow.svelte'),
  'utf8',
)
describe('conversation activity row', () => {
  test('keeps the whole turn summary on the compact caption rung', () => {
    // WHY: the summary, its target, and its right-side steps and time are one
    // row. They must stay at 12px together on every display.
    for (const selector of ['activity-label', 'activity-target', 'activity-rail']) {
      expect(activityRow).toMatch(
        new RegExp(`\\.${selector}\\s*{[\\s\\S]*?font-size: var\\(--text-xs\\);`),
      )
    }
    expect(activityRow).not.toContain('font-size: var(--text-workspace-chrome);')
  })
})
