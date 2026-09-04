import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const component = (name: string) =>
  readFileSync(
    new URL(
      `../../packages/workspace-ui/src/components/pr-review/${name}.svelte`,
      import.meta.url,
    ),
    'utf8',
  )

const menu = component('PrOverflowMenu')
const feed = component('ActivityFeed')
const pane = component('PrReviewPane')
const workspace = readFileSync(
  new URL(
    '../../packages/workspace-ui/src/contexts/workspace/workspace.context.svelte.ts',
    import.meta.url,
  ),
  'utf8',
)
const keybindings = readFileSync(
  new URL('../../packages/workspace-ui/src/lib/keybindings/manifest.ts', import.meta.url),
  'utf8',
)

describe('pull request rail overflow menu', () => {
  test('keeps the PR-aware agent handoffs beside the merge action', () => {
    // WHY: these commands belong to the pull request that the status card is
    // about. A generic new chat loses that review context and its checkout.
    expect(menu).toContain('Ask a question')
    expect(menu).not.toContain('Explain this PR')
    expect(menu).toContain('Fix comments in a session')
    expect(menu).toContain('Opens a session that knows which pull request you mean.')
    expect(feed).toContain('{onChat}')
    expect(feed).toContain('onFixComments={feedbackCount > 0 && onAddressComments')
  })

  test('opens Ask and Fix comments through the visible checkout-card flow', () => {
    expect(pane).toContain('async function openChat()')
    expect(pane).toContain('async function openFixComments(feedback?: PrFixFeedback)')
    expect(pane).toContain('fixTabId = await session.openPrReviewChat(pr')
    expect(pane).toContain('session.failPrReviewChatCheckout(fixTabId')
    expect(pane).toContain('startPrCommentsFixSession(sourceContext, feedback, fixTabId)')
  })

  test('keeps Ask taskless and makes the fix session task-backed', () => {
    // WHY: Ask is an exploratory conversation and belongs in the loose session
    // list. Fix comments is committed work and must create the task exception.
    expect(pane).toMatch(/async function openChat\(\)[\s\S]*?task: "none"/)
    expect(pane).toMatch(/async function openFixComments[\s\S]*?task: "new"/)
    expect(workspace).toContain("if (opts.task === 'none') reviewSession.task = { kind: 'none' }")
    expect(workspace).toMatch(
      /startPrCommentsFixSession\([\s\S]*?\{ existingTabId \},[\s\S]*?\)/,
    )
  })

  test('includes the host link commands and remains usable at phone width', () => {
    expect(menu).toContain('Open on {pr.host?.includes("github") ? "GitHub"')
    expect(menu).toContain('Copy link')
    expect(menu).toContain('w-[min(23rem,calc(100vw-2rem))]')
    expect(menu).toMatch(
      /onInteractOutside=\{\(event\) => \{[\s\S]*triggerEl\?\.contains\(event\.target as Node\)[\s\S]*event\.preventDefault\(\)/,
    )
  })

  test('copies the GitHub link with Command-Control-C', () => {
    expect(keybindings).toContain(
      "'pr-review.copy-link':          { combo: { mod: true, ctrl: true, code: 'KeyC' }",
    )
    expect(pane).toContain('"pr-review.copy-link"')
    expect(pane).toContain('await copyText(prUrl)')
    expect(pane).toContain('{ enabled: () => !headless && !!prUrl }')
  })
})
