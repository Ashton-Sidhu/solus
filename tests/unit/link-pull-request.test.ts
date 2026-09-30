import { describe, expect, test } from 'bun:test'
import {
  checkPullRequestUrl,
  taskPullRequestLink,
} from '@solus/workspace-ui/components/session/lib/link-pull-request'

describe('linking a pull request by its URL', () => {
  test('an empty field is not an error', () => {
    expect(checkPullRequestUrl('   ')).toEqual({ kind: 'empty' })
  })

  test('a bare number or an issue is refused', () => {
    // WHY: a number names no repository, so the link could land on the wrong
    // pull request. The dialog takes the page's URL only.
    expect(checkPullRequestUrl('412')).toEqual({ kind: 'invalid' })
    expect(checkPullRequestUrl('https://github.com/acme/solus/issues/412')).toEqual({ kind: 'invalid' })
  })

  test('a pull request URL is accepted without its query and hash', () => {
    expect(checkPullRequestUrl(' https://github.com/acme/solus/pull/412?diff=split#top ')).toEqual({
      kind: 'valid',
      url: 'https://github.com/acme/solus/pull/412',
      label: 'acme/solus #412',
    })
  })

  test('a task link names the repository in lower case, as the host stores it', () => {
    expect(taskPullRequestLink('https://github.com/Acme/Solus/pull/412')).toEqual({
      kind: 'pr',
      targetScope: 'github.com/acme/solus',
      targetKey: '412',
      url: 'https://github.com/Acme/Solus/pull/412',
    })
    expect(taskPullRequestLink('not a url')).toBeNull()
  })
})
