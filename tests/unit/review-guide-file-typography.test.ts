import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const workspaceSource = (path: string) =>
  readFileSync(new URL(`../../packages/workspace-ui/src/${path}`, import.meta.url), 'utf8')

describe('review file typography', () => {
  test('guide file rows and card headers use the smaller responsive rung', () => {
    const guideSection = workspaceSource('components/pr-review/guide/GuideSection.svelte')

    expect(guideSection.match(/text-left text-chrome-shelf/g)).toHaveLength(2)
  })

  test('diff panel file headers use the responsive workspace rung', () => {
    const diffStream = workspaceSource('components/diff/DiffStream.svelte')

    expect(diffStream).toContain('font-size: var(--text-workspace-chrome)')
    expect(diffStream).toContain('line-height: var(--text-workspace-chrome--line-height)')
  })
})
