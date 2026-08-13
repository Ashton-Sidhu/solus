import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const paneSource = readFileSync(
  join(import.meta.dir, '../../src/renderer/components/ui/Pane.svelte'),
  'utf8',
)
const pillLayoutSource = readFileSync(
  join(import.meta.dir, '../../src/renderer/components/layout/PillLayout.svelte'),
  'utf8',
)

describe('pull request lazy-loading state', () => {
  test('uses the PR page skeleton at both renderer loading boundaries', () => {
    // WHY: opening the PR page must immediately show its final geometry instead
    // of a text label that shifts when the lazy module finishes loading.
    expect(paneSource).toMatch(
      /ref\.name === "prs"[\s\S]*<PrsPageSkeleton \/>/,
    )
    expect(pillLayoutSource).toMatch(
      /{#await import\("\.\.\/prs\/PrsPage\.svelte"\)}\s*<PrsPageSkeleton \/>/,
    )
  })
})
