import { describe, expect, it } from 'bun:test'
import { taskPrNavigation } from '@solus/workspace-ui/components/session/lib/pr-navigation'
import { routeForHref } from '@solus/workspace-ui/lib/agent-links'
import type { TaskPrChoice } from '@solus/workspace-ui/components/session/lib/task-list'
import { pullRequestFixture } from './__fixtures__/pull-request'

const choice: TaskPrChoice = {
  number: 43,
  title: 'Fix navigation',
  targetScope: '/other-host/repo',
  url: 'https://github.com/acme/repo/pull/43',
  pullRequest: null,
}

describe('task PR navigation', () => {
  it('opens a URL through the same route as an assistant message, without overriding its workspace', () => {
    const navigation = taskPrNavigation(choice)
    expect(navigation.route).toEqual(routeForHref(choice.url!, { title: choice.title }))
    // Supplying the original URL makes openRoute check access before navigation
    // and gives a failed check the same browser destination as the message link.
    expect(navigation.sourceUrl).toBe(choice.url!)
    expect(navigation.route.params.serverId).toBeUndefined()
    expect(navigation.route.params.cwd).toBeUndefined()
  })

  it('uses URL identity even when a saved choice has a different number', () => {
    const navigation = taskPrNavigation({ ...choice, number: 7 })
    expect(navigation.route.params.number).toBe(43)
    expect(navigation.route.params.expectedRepo).toEqual({
      host: 'github.com', owner: 'acme', repo: 'repo',
    })
  })

  it('uses the current PR URL when the task link has none', () => {
    const pullRequest = pullRequestFixture(43, { title: 'Current title' })
    const navigation = taskPrNavigation({ ...choice, url: null, pullRequest })
    expect(navigation.sourceUrl).toBe(pullRequest.url)
    expect(navigation.route).toEqual(routeForHref(pullRequest.url, { title: 'Current title' }))
  })

  it('keeps number-only choices usable without inventing a browser URL', () => {
    const navigation = taskPrNavigation({ ...choice, url: null })
    expect(navigation.sourceUrl).toBeUndefined()
    expect(navigation.route.params.number).toBe(43)
    expect(navigation.route.params.expectedRepo).toBeUndefined()
    expect(navigation.route.params.cwd).toBeUndefined()
  })
})
