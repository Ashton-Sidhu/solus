import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '../..')
const markdownLink = readFileSync(
  join(root, 'packages/workspace-ui/src/components/conversation/MarkdownLink.svelte'),
  'utf8',
)
const workspace = readFileSync(
  join(root, 'packages/workspace-ui/src/contexts/workspace/workspace.context.svelte.ts'),
  'utf8',
)

describe('conversation pull request links', () => {
  test('preserves the original web URL as the browser fallback', () => {
    // WHY: a repository that Solus cannot read must still open at the exact
    // link the assistant provided, on the device where the user clicked it.
    expect(markdownLink).toContain('externalFallbackUrl:')
    expect(markdownLink).toContain('? href')
  })

  test('checks access before changing the visible workspace', () => {
    // WHY: failed access must not flash a PR pane or switch Pill mode to Editor
    // mode before the browser opens.
    const start = workspace.indexOf('if (opts.externalFallbackUrl) {')
    const navigate = workspace.indexOf('const pane = this.router.navigate(ref', start)
    const resolve = workspace.indexOf('preflightedPr = await resolve()', start)
    const fallback = workspace.indexOf('localApi.openExternal(opts.externalFallbackUrl)', start)

    expect(start).toBeGreaterThan(-1)
    expect(resolve).toBeGreaterThan(start)
    expect(fallback).toBeGreaterThan(resolve)
    expect(navigate).toBeGreaterThan(fallback)
  })
})
