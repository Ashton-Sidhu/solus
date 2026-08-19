import { describe, expect, test } from 'bun:test'
import { routeForHref } from '@solus/workspace-ui/lib/agent-links'

describe('agent link routes', () => {
  test('opens Solus PR references as PR review routes', () => {
    // WHY: PR chips in a transcript must use the in-app review surface rather
    // than escape to the browser.
    expect(routeForHref('pr://ref?number=42')).toEqual({
      name: 'prReview',
      params: { number: 42, title: undefined },
    })
  })

  test('recognizes canonical GitHub pull-request links', () => {
    // WHY: agents commonly emit the host URL instead of Solus's reference
    // syntax; both forms must reach the same pane-routing command.
    expect(routeForHref('https://github.com/openai/codex/pull/314')).toEqual({
      name: 'prReview',
      params: {
        number: 314,
        title: undefined,
        expectedRepo: { host: 'github.com', owner: 'openai', repo: 'codex' },
      },
    })
  })

  test('leaves other GitHub links external', () => {
    expect(routeForHref('https://github.com/openai/codex/issues/314')).toBeNull()
  })
})
