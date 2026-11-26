import { describe, expect, test } from 'bun:test'
import { parseIssueKey, issueKey, issueSourceKey, type IssueRef } from '@solus/contracts/task-sources'

describe('task source keys', () => {
  test('two projects that name the same board in different case share one source', () => {
    // The source key is what the host caches and refreshes by. GitHub does not
    // distinguish case, so two spellings must not cause two reads of one board.
    expect(issueSourceKey({ kind: 'github-project', owner: 'Acme', number: 4 }))
      .toBe(issueSourceKey({ kind: 'github-project', owner: 'acme', number: 4 }))
    expect(issueSourceKey({ kind: 'github-repo', owner: 'Acme', repo: 'App' })).toBe('github-repo:acme/app')
  })

  test('a repository and a board with the same owner are different sources', () => {
    expect(issueSourceKey({ kind: 'jira-project', cloudId: 'site', projectKey: 'sol' })).toBe('jira-project:site/SOL')
    expect(issueSourceKey({ kind: 'jira-board', cloudId: 'site', boardId: 12 })).toBe('jira-board:site/12')
  })
})

describe('task keys', () => {
  test('a task key gives back the ref it was made from', () => {
    // Each attachment stores only the key; the host needs the ref to ask the provider.
    const refs: IssueRef[] = [
      { provider: 'github', id: 'I_kwDOABC123' },
      { provider: 'jira', cloudId: '11f0-aa', id: '10042' },
    ]
    for (const ref of refs) expect(parseIssueKey(issueKey(ref))).toEqual(ref)
  })

  test('an id from before tasks were provider-owned is not a task key', () => {
    expect(parseIssueKey('01M3AZ4M9Z4YNKD6TGDY2300B0')).toBeNull()
    expect(parseIssueKey('jira:10042')).toBeNull()
    expect(parseIssueKey('github:')).toBeNull()
  })
})
