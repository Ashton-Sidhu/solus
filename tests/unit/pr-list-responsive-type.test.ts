import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const row = readFileSync(
  new URL(
    '../../packages/workspace-ui/src/components/prs/PrListRow.svelte',
    import.meta.url,
  ),
  'utf8',
)

describe('pull request list type', () => {
  test('uses the shared desktop and mobile workspace type rung for titles', () => {
    // WHY: fixed `text-sm` stays 14px on a laptop and does not follow the
    // shared 12px laptop / 14px desktop-and-touch display scale.
    expect(row).toContain('truncate text-workspace-chrome font-medium text-foreground')
    expect(row).not.toContain('truncate text-sm font-medium text-foreground')
  })
})
