import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '../..')
const markdownLink = readFileSync(
  join(root, 'packages/workspace-ui/src/components/conversation/MarkdownLink.svelte'),
  'utf8',
)
const taskPage = readFileSync(
  join(root, 'packages/workspace-ui/src/components/tasks/task-page/TaskPage.svelte'),
  'utf8',
)
const taskSection = readFileSync(
  join(root, 'packages/workspace-ui/src/components/project-panel/TaskSection.svelte'),
  'utf8',
)
const sessionSidebar = readFileSync(
  join(root, 'packages/workspace-ui/src/components/session/SessionSidebar.svelte'),
  'utf8',
)
const workspace = readFileSync(
  join(root, 'packages/workspace-ui/src/contexts/workspace/workspace.context.svelte.ts'),
  'utf8',
)

describe('pull request link fallbacks', () => {
  test('preserves the original web URL as the browser fallback', () => {
    // WHY: a repository that Solus cannot read must still open at the exact
    // link the assistant provided, on the device where the user clicked it.
    expect(markdownLink).toContain('sourceUrl:')
    expect(markdownLink).toContain('? href')
  })

  test('passes remote identity as PR data from every task link surface', () => {
    // WHY: fallback is not a caller option. Each URL-bearing task surface gives
    // the shared command its complete PR target, and that command owns policy.
    expect(taskPage).toContain('url: link.url')
    expect(taskSection).toContain('url: link.url')
    expect(sessionSidebar).toContain('url: linkedPr?.url')
    expect(taskPage).not.toContain('externalFallbackUrl')
    expect(taskSection).not.toContain('externalFallbackUrl')
    expect(sessionSidebar).not.toContain('externalFallbackUrl')
  })

  test('derives fallback centrally from the PR target', () => {
    // WHY: adding another PR-opening surface must not require reimplementing or
    // opting into local-first navigation policy.
    const command = workspace.indexOf('async openPullRequest(')
    const derivesUrl = workspace.indexOf('pullRequestExternalUrl(target)', command)
    const opensRoute = workspace.indexOf('this.openPrReviewRoute(', command)

    expect(command).toBeGreaterThan(-1)
    expect(derivesUrl).toBeGreaterThan(command)
    expect(opensRoute).toBeGreaterThan(derivesUrl)
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
