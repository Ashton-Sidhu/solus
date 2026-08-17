import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const root = join(import.meta.dir, '../..')

describe('PR Ask Solus latency', () => {
  test('reveals the conversation before preparing the checkout', () => {
    // WHY: checkout preparation can fetch refs and create a worktree. The Ask
    // Solus click must show its destination before that slow host work finishes.
    const source = readFileSync(
      join(root, 'src/renderer/components/pr-review/PrReviewPane.svelte'),
      'utf8',
    )
    const handler = source.slice(
      source.indexOf('async function openChat()'),
      source.indexOf('\n  function exit()', source.indexOf('async function openChat()')),
    )

    expect(handler.indexOf('openPrReviewChat(pr')).toBeGreaterThan(-1)
    expect(handler.indexOf('ensureCheckout()')).toBeGreaterThan(handler.indexOf('openPrReviewChat(pr'))
  })

  test('blocks the draft until it is attached to the PR checkout', () => {
    const source = readFileSync(
      join(root, 'src/renderer/contexts/workspace/workspace.context.svelte.ts'),
      'utf8',
    )
    const start = source.indexOf('async openPrReviewChat(')
    const handler = source.slice(start, source.indexOf('\n  /** Split the review:', start))

    expect(handler).toContain("reviewSession.status = 'connecting'")
    expect(handler).toContain('this.attachPrReviewCheckout(existingTabId, checkout)')
    expect(handler).toContain("if (reviewSession.status === 'connecting') reviewSession.status = 'idle'")
    expect(source).toContain("this.router.asidePanes[0]?.id ?? 'aside'")
  })

  test('creates the immediate draft from the PR project context', () => {
    // WHY: embedded PR review has no `prReview` route. Falling back to the
    // active conversation silently puts Ask Solus in an unrelated project.
    const pane = readFileSync(
      join(root, 'src/renderer/components/pr-review/PrReviewPane.svelte'),
      'utf8',
    )
    const workspace = readFileSync(
      join(root, 'src/renderer/contexts/workspace/workspace.context.svelte.ts'),
      'utf8',
    )
    const start = workspace.indexOf('async openPrReviewChat(')
    const handler = workspace.slice(start, workspace.indexOf('\n  private attachPrReviewCheckout', start))

    expect(pane).toContain('projectCtx: projectCtx()')
    expect(handler).toContain('const pendingDirectory = opts.projectCtx?.session.projectPath')
    expect(handler).not.toContain('this.activeSession')
  })
})
