import { describe, expect, test } from 'bun:test'
import { inferTaskSourceKey } from '@solus/contracts/task-sources'

const REPO = 'github-repo:acme/app'
const BOARD = 'github-project:acme/7'
const JIRA = 'jira-project:cloud-1/SOL'
const SOURCES = [REPO, BOARD, JIRA]

describe('where a new task goes when nobody names a source', () => {
  test('the source of the task the work is about comes first', () => {
    // WHY: a follow-up of a Jira issue belongs in the same Jira project, even
    // when the session works in a checkout of a repository that is a source too.
    expect(inferTaskSourceKey(SOURCES, { taskSourceKeys: [JIRA], repository: { owner: 'acme', repo: 'app' } })).toBe(JIRA)
  })

  test('a task on two sources goes to the first of them in the person\'s order', () => {
    expect(inferTaskSourceKey(SOURCES, { taskSourceKeys: [BOARD, REPO] })).toBe(REPO)
  })

  test('else the source of the GitHub repository the work is done in, in any case', () => {
    expect(inferTaskSourceKey(SOURCES, { repository: { owner: 'Acme', repo: 'App' } })).toBe(REPO)
  })

  test('else the source the person chose last, while they still have it', () => {
    expect(inferTaskSourceKey(SOURCES, { repository: { owner: 'other', repo: 'repo' }, lastSourceKey: BOARD })).toBe(BOARD)
    expect(inferTaskSourceKey(SOURCES, { lastSourceKey: 'github-repo:gone/away' })).toBeNull()
  })

  test('one source needs no hint; several sources and no hint is a choice', () => {
    // WHY: there is no default source to set. A guess among several sources
    // would put a task where nobody looks, so the person or the agent chooses.
    expect(inferTaskSourceKey([BOARD])).toBe(BOARD)
    expect(inferTaskSourceKey(SOURCES)).toBeNull()
    expect(inferTaskSourceKey([])).toBeNull()
  })
})
