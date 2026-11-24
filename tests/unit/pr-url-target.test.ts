import { describe, expect, test } from 'bun:test'
import { prUrlTarget } from '@solus/workspace-ui/components/prs/lib/pr-url-project'

const options = [
  { key: 'github.com/acme/web', serverId: 'laptop', available: true },
  { key: 'github.com/acme/api', serverId: 'away', available: true },
  { key: 'github.com/acme/docs', serverId: 'laptop', available: false },
]
const reachable = (serverId: string) => serverId === 'laptop'

describe('a pasted pull request URL', () => {
  test('is read through the project that is a checkout of its repository', () => {
    // GitHub names are case-insensitive; the project key is the lowercase form.
    const target = prUrlTarget('https://github.com/Acme/Web/pull/42?tab=files', options, reachable)
    expect(target.number).toBe(42)
    expect(target.repository).toBe('github.com/acme/web')
    expect(target.project?.key).toBe('github.com/acme/web')
  })

  test('is read through its repository when no reachable project holds it', () => {
    // Not a project at all, a project whose host is away, and an inert project
    // each fall back to the repository, so the pull request still opens.
    for (const url of [
      'https://github.com/other/site/pull/7',
      'https://github.com/acme/api/pull/7',
      'https://github.com/acme/docs/pull/7',
    ]) {
      const target = prUrlTarget(url, options, reachable)
      expect(target.project).toBeNull()
      expect(target.repository).toBe(url.slice('https://'.length, url.indexOf('/pull/')).toLowerCase())
    }
  })

  test('that is not a GitHub pull request is refused with the message the field shows', () => {
    expect(() => prUrlTarget('https://github.com/acme/web/issues/3', options, reachable)).toThrow(
      'Paste a GitHub pull request URL.',
    )
  })
})
