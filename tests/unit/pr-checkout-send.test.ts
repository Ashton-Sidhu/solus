import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import type { PrReviewContext, RunConfig, StatusCardState } from '@solus/contracts/types'

/**
 * A session started from a pull request's page opens before the PR's worktree
 * exists. The checkout runs behind a setup card in that conversation, and the
 * prompt is sent only once the session points at the checkout — never into the
 * project it was opened from.
 */

mock.module('@solus/workspace-ui/lib/analytics', () => ({ track: () => {} }))
const focusRequests: Array<{ tabId?: string } | undefined> = []
mock.module('@solus/workspace-ui/lib/inputFocus', () => ({
  FOCUS_INPUT_EVENT: 'solus:focus-input',
  requestInputFocus: (target?: { tabId?: string }) => { focusRequests.push(target) },
  blurActiveTextInputOnMobile: () => {},
}))
mock.module('svelte-sonner', () => ({ toast: Object.assign(() => '', { success: () => '', error: () => '', dismiss: () => {} }) }))

const previousState = (globalThis as unknown as { $state?: unknown }).$state
let PrReviewActions: typeof import('@solus/workspace-ui/contexts/workspace/pr-review-actions')['PrReviewActions']

beforeAll(async () => {
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
    <T>(value: T) => value,
    { snapshot: <T>(value: T) => value, raw: <T>(value: T) => value },
  )
  ;({ PrReviewActions } = await import('@solus/workspace-ui/contexts/workspace/pr-review-actions'))
})

afterAll(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

const REVIEW = {
  number: 42,
  title: 'Keep sessions alive',
  worktreePath: '/code/solus/.worktrees/pr-42',
  branch: 'feature/sessions',
} as PrReviewContext

function harness() {
  const session = {
    status: 'idle' as string,
    currentTurnStartedAt: null as number | null,
    statusCard: null as StatusCardState | null,
    prompt: { text: '' },
    prReview: null as PrReviewContext | null,
    run: { workingDirectory: '/code/solus', gitContext: null, serverId: 'local', worktree: null, permissionMode: 'default' } as unknown as RunConfig,
  }
  const sent: Array<{ prompt: string; cwd: string }> = []
  const workspace = {
    sessionFor: (tabId: string) => (tabId === 'tab-1' ? session : undefined),
    dispatch: {
      sendMessage: (prompt: string) => {
        sent.push({ prompt, cwd: session.run.workingDirectory })
        return true
      },
    },
  }
  let resolve!: (review: PrReviewContext) => void
  let reject!: (error: Error) => void
  const checkout = new Promise<PrReviewContext>((res, rej) => { resolve = res; reject = rej })
  const actions = new PrReviewActions(workspace as never)
  const run = actions.sendAfterPrCheckout('tab-1', 'review the retry logic', {
    number: 42,
    serverId: 'local',
    prepare: () => checkout,
  })
  return { session, sent, resolve, reject, run }
}

describe('sending from a pull request page', () => {
  test('shows the checkout in the conversation and holds the prompt until it is ready', () => {
    const { session, sent } = harness()

    // WHY: the conversation is on screen before the worktree exists; the card
    // is where the wait is seen, and nothing may run in the wrong checkout.
    expect(session.status).toBe('connecting')
    expect(session.statusCard?.status).toBe('active')
    expect(session.statusCard?.steps[0]).toMatchObject({ id: 'checkout', status: 'active' })
    expect(sent).toHaveLength(0)
  })

  test('sends the prompt into the PR worktree once it exists', async () => {
    const { session, sent, resolve, run } = harness()

    resolve(REVIEW)
    await run

    // WHY: the agent must start in the PR's checkout, bound to the PR.
    expect(sent).toEqual([{ prompt: 'review the retry logic', cwd: '/code/solus/.worktrees/pr-42' }])
    expect(session.prReview).toBe(REVIEW)
    expect(session.statusCard?.status).toBe('done')
  })

  test('a failed checkout stays on the card and gives the words back', async () => {
    const { session, sent, reject, run } = harness()

    reject(new Error('gh: authentication required'))
    await run

    // WHY: the reason belongs where the user is looking, and what they typed
    // must be ready to send again rather than lost.
    expect(sent).toHaveLength(0)
    expect(session.status).toBe('idle')
    expect(session.statusCard?.status).toBe('error')
    expect(session.statusCard?.steps[0].detail).toBe('gh: authentication required')
    expect(session.prompt.text).toBe('review the retry logic')
    expect(focusRequests.at(-1)).toEqual({ tabId: 'tab-1' })
  })

  test('Stop during the checkout withdraws the send', async () => {
    const { session, sent, resolve, run } = harness()

    session.status = 'idle'
    resolve(REVIEW)
    await run

    // WHY: a stopped turn must not start by itself when the checkout lands.
    expect(sent).toHaveLength(0)
    expect(session.statusCard).toBeNull()
    expect(session.prompt.text).toBe('review the retry logic')
  })
})
