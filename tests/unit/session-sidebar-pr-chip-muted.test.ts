import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const taskRow = readFileSync(
  new URL('../../packages/workspace-ui/src/components/session/TaskRow.svelte', import.meta.url),
  'utf8',
)

describe('session sidebar pull request chip emphasis', () => {
  test('mutes pull request chips with quiet rows and restores them on hover', () => {
    // WHY: PR state colours are explicit, so they do not inherit the muted ink
    // of a receding row. The chip must follow the same hierarchy as its title.
    const mutedChipWrappers = taskRow.match(
      /class="flex shrink-0 items-center transition-opacity duration-150 \{recedes\s*\? 'opacity-75 group-hover\/row:opacity-100'\s*: ''\}"/g,
    )

    expect(mutedChipWrappers).toHaveLength(2)
  })
})
