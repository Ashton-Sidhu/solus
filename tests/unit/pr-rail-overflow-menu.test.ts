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
const submitReviewModal = component('SubmitReviewModal')
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
    // about, but the user must stay in control of when the prepared text runs.
    expect(menu).toContain('Ask a question')
    expect(menu).not.toContain('Explain this PR')
    expect(menu).toContain('Draft fixes for comments')
    expect(menu).toContain('Starts a PR-aware question in the input bar.')
    expect(feed).toContain('{onChat}')
    expect(feed).toContain('onFixComments={feedbackCount > 0 && onAddressComments')
  })

  test('prepares the checkout before routing PR input into a session composer', () => {
    expect(pane).toContain('async function openPrChat(draft?: string)')
    expect(pane).toContain('async function openFixDraft(prompt: string, title: string)')
    expect(pane).toMatch(
      /const sourceContext = await review\.ensureCheckout\(\);[\s\S]*?session\.openPrReviewDraft\(sourceContext/,
    )
    expect(pane).toContain('prompt: draft')
    expect(pane).toContain('prompt,')
    expect(pane).toContain('task: "new"')
    expect(pane).not.toContain('session.sendMessage')
    expect(pane).not.toContain('session.openPrReviewChat')
    expect(workspace).toContain('openPrReviewDraft(')
    expect(workspace).toContain('const draft = this.openSessionDraft(')
    expect(workspace).toContain('draft.prReview = pr')
    expect(workspace).not.toContain('startPrCommentsFixSession')
    expect(workspace).not.toContain('startPrCheckFixSession')
    expect(submitReviewModal).toContain('Submit & draft fixes')
    expect(submitReviewModal).not.toContain('Submit & send to fix agent')
  })

  test('keeps the explicit checkout command separate from prompt drafting', () => {
    expect(pane).toContain('onclick={() => void openPrChat()}')
    expect(pane).toContain('onChat={() => void openPrChat(buildPrQuestionDraft(target))}')
    expect(pane).toContain('{openingChat ? "Preparing…" : "Check out"}')
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
