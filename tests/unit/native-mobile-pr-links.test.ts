import { describe, expect, test } from 'bun:test'
import { parsePullRequestHref } from '@solus/contracts/providers'
import { openPullRequestLink, pullRequestLinkRef } from '../../apps/mobile/src/features/prs/lib/pull-request-link'

const solus = { path: '/repo/solus', repositoryKey: 'github.com/acme/solus' }
const site = { path: '/repo/site', repositoryKey: 'github.com/acme/site' }
const notes = { path: '/notes', repositoryKey: null }
const projects = [solus, site, notes]

describe('parsePullRequestHref', () => {
  // WHY: web and mobile must agree on which message links are pull requests,
  // so a link opens the same pull request on each client.
  test('reads a GitHub pull request URL with its repository', () => {
    expect(parsePullRequestHref('https://github.com/Acme/Site/pull/12')).toEqual({
      number: 12,
      baseRepo: { host: 'github.com', owner: 'Acme', repo: 'Site' },
    })
  })

  test('reads a pr:// reference as a pull request of the own project', () => {
    expect(parsePullRequestHref('pr://ref?number=42&title=Fix')).toEqual({ number: 42, baseRepo: null })
  })

  test('leaves other links alone', () => {
    expect(parsePullRequestHref('https://github.com/acme/site/issues/12')).toBeNull()
    expect(parsePullRequestHref('https://example.com/acme/site/pull/12')).toBeNull()
    expect(parsePullRequestHref('pr://ref?number=0')).toBeNull()
    expect(parsePullRequestHref('session://open?provider=codex&sessionId=s')).toBeNull()
  })
})

describe('pullRequestLinkRef', () => {
  const link = (href: string) => parsePullRequestHref(href)!

  test('opens a GitHub link in the own project when it is that repository', () => {
    expect(pullRequestLinkRef(link('https://github.com/acme/solus/pull/7'), 'h1', '/repo/solus/.git/solus/worktrees/w1', projects))
      .toEqual({ hostId: 'h1', projectPath: '/repo/solus', number: 7 })
  })

  test('opens a link to another repository in that repository\'s project on the host', () => {
    expect(pullRequestLinkRef(link('https://github.com/ACME/site/pull/3'), 'h1', '/repo/solus', projects))
      .toEqual({ hostId: 'h1', projectPath: '/repo/site', number: 3 })
  })

  test('leaves a repository no project of the host reads to the browser', () => {
    // WHY: the host reads pull requests from a project's own remote; another
    // repository's project would show the wrong pull request.
    expect(pullRequestLinkRef(link('https://github.com/someone/else/pull/3'), 'h1', '/repo/solus', projects)).toBeNull()
  })

  test('opens a pr:// link in the own project only', () => {
    expect(pullRequestLinkRef(link('pr://ref?number=9'), 'h1', '/repo/site/src', projects))
      .toEqual({ hostId: 'h1', projectPath: '/repo/site', number: 9 })
    // An unknown folder: the host finds its repository.
    expect(pullRequestLinkRef(link('pr://ref?number=9'), 'h1', '/tmp/x', projects))
      .toEqual({ hostId: 'h1', projectPath: '/tmp/x', number: 9 })
    expect(pullRequestLinkRef(link('pr://ref?number=9'), 'h1', '/notes', projects)).toBeNull()
    expect(pullRequestLinkRef(link('pr://ref?number=9'), 'h1', '', projects)).toBeNull()
  })
})

describe('openPullRequestLink', () => {
  function actions(listed = projects) {
    const opened: { pullRequest: unknown[]; browser: string[] } = { pullRequest: [], browser: [] }
    return {
      opened,
      actions: {
        listProjects: async () => listed,
        openPullRequest: (ref: unknown) => void opened.pullRequest.push(ref),
        openBrowser: (href: string) => void opened.browser.push(href),
      },
    }
  }
  // A pull request's description, comments, and guide have no session: their
  // links read against the pull request's own project and host, as the
  // pull request pane does on desktop and web.
  const prScreen = { hostId: 'h1', workingDirectory: '/repo/solus' }

  test('opens a pr:// link in a pull request description in that pull request\'s project', async () => {
    const { opened, actions: open } = actions()
    await openPullRequestLink('pr://ref?number=9', prScreen, open)
    expect(opened).toEqual({ pullRequest: [{ hostId: 'h1', projectPath: '/repo/solus', number: 9 }], browser: [] })
  })

  test('opens a GitHub link to another repository of the host in the app', async () => {
    const { opened, actions: open } = actions()
    await openPullRequestLink('https://github.com/acme/site/pull/3', prScreen, open)
    expect(opened).toEqual({ pullRequest: [{ hostId: 'h1', projectPath: '/repo/site', number: 3 }], browser: [] })
  })

  test('opens a GitHub link no project reads in the browser, and drops such a pr:// link', async () => {
    const { opened, actions: open } = actions([])
    await openPullRequestLink('https://github.com/someone/else/pull/3', prScreen, open)
    await openPullRequestLink('pr://ref?number=9', null, open)
    expect(opened).toEqual({ pullRequest: [], browser: ['https://github.com/someone/else/pull/3'] })
  })

  test('leaves other links to the caller', () => {
    const { actions: open } = actions()
    expect(openPullRequestLink('https://example.com/a', prScreen, open)).toBeNull()
  })
})
