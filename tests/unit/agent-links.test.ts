import { describe, expect, test } from 'bun:test'
import { parseGitHubPullRequestUrl } from '@solus/contracts/providers'
import { routeForHref } from '@solus/workspace-ui/lib/agent-links'
import { externalPrLinkCandidate } from '@solus/workspace-ui/components/tasks/task-page/lib/external-pr-link'

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

  test('turns a pasted GitHub PR URL into a durable task link', () => {
    // WHY: external PRs may not be present in the current project's PR list.
    expect(externalPrLinkCandidate('https://github.com/openai/codex/pull/314'))
      .toEqual({
        input: {
          kind: 'pr',
          targetScope: 'github.com/openai/codex',
          targetKey: '314',
          title: '#314 openai/codex',
          url: 'https://github.com/openai/codex/pull/314',
        },
        label: '#314',
        meta: 'openai/codex',
      })
    expect(parseGitHubPullRequestUrl('https://github.com/openai/codex/issues/314')).toBeNull()
  })

  test('opens task references on the host that wrote the transcript', () => {
    // WHY: task links in assistant and user messages must resolve on their
    // source host before the conversation opens them in a companion pane.
    expect(routeForHref('task://ref?taskId=01JTASK', { serverId: 'host-a' })).toEqual({
      name: 'task',
      params: { taskId: '01JTASK', serverId: 'host-a' },
    })
  })

  test('opens work references on the host that wrote the transcript', () => {
    // WHY: work ids are host-local. A link read through app.solus.sh must not
    // ask whichever host happens to be the client's default for its content.
    expect(routeForHref('work://ref?workId=01JWORK', { serverId: 'host-a' })).toEqual({
      name: 'work',
      params: { workId: '01JWORK', serverId: 'host-a' },
    })
  })
})
