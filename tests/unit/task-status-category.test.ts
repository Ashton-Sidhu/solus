import { describe, expect, test } from 'bun:test'
import { GitHubReauthRequiredError } from '@solus/server/providers/github/octokit'
import { classifyProviderFailure, taskWriteError } from '@solus/server/data/tasks/providers/failures'
import { JiraRequestError, TaskProviderError } from '@solus/server/data/tasks/providers/types'
import {
  githubIssueCategory,
  githubProjectOptionCategory,
  jiraStatusCategory,
  taskCategory,
} from '@solus/server/data/tasks/status-category'
import { TASKS_AUTH_ERROR_PREFIX } from '@solus/contracts/task-types'

// WHY: the status category is the one fact that agent rules and mixed views
// read from a provider's own words. A wrong category makes a session move a
// finished task, or settle the sessions of a task that is not finished.

describe('status category of a provider state or column', () => {
  test('Jira gives the category: new is open, indeterminate is active, done is done', () => {
    expect(jiraStatusCategory('new')).toBe('open')
    expect(jiraStatusCategory('indeterminate')).toBe('active')
    expect(jiraStatusCategory('done')).toBe('done')
    // A key Jira adds later must not read as work in progress or as finished.
    expect(jiraStatusCategory('undefined')).toBe('open')
  })

  test('a GitHub issue is open or done; GitHub has no state for work in progress', () => {
    expect(githubIssueCategory('OPEN')).toBe('open')
    expect(githubIssueCategory('CLOSED')).toBe('done')
  })

  test('a GitHub Project option is read from its name, and an unknown name is open', () => {
    expect(githubProjectOptionCategory('Done')).toBe('done')
    expect(githubProjectOptionCategory('✅ Shipped')).toBe('done')
    expect(githubProjectOptionCategory('In progress')).toBe('active')
    expect(githubProjectOptionCategory('In review')).toBe('active')
    expect(githubProjectOptionCategory('Todo')).toBe('open')
    expect(githubProjectOptionCategory('Backlog')).toBe('open')
    expect(githubProjectOptionCategory('Icebox')).toBe('open')
    // A name Solus does not know must never end the work of a session.
    expect(githubProjectOptionCategory('Abandoned')).toBe('open')
  })

  test('a task is done only when its provider state is done, and active when its state or one column is', () => {
    expect(taskCategory('done', ['open', 'active'])).toBe('done')
    expect(taskCategory('active', [])).toBe('active')
    expect(taskCategory('open', ['open', 'active'])).toBe('active')
    expect(taskCategory('open', ['open'])).toBe('open')
    // An open issue in a Done column is not finished: the provider did not close it.
    expect(taskCategory('open', ['done'])).toBe('open')
  })
})

// WHY: the health of a source tells the person what to do: connect, connect
// again, ask for access, or wait. A wrong class sends them to the wrong fix.

describe('what a failed provider call means for the connection', () => {
  test('no credential is not_connected', () => {
    expect(classifyProviderFailure(new Error('GitHub is not connected')).health).toBe('not_connected')
    expect(classifyProviderFailure(new TaskProviderError('not_connected', 'Connect Atlassian to read Jira tasks.'))).toEqual({
      health: 'not_connected', message: 'Connect Atlassian to read Jira tasks.',
    })
  })

  test('a missing scope or a dead token is reconnect', () => {
    expect(classifyProviderFailure({ errors: [{ type: 'INSUFFICIENT_SCOPES' }] }).health).toBe('reconnect')
    expect(classifyProviderFailure(new GitHubReauthRequiredError()).health).toBe('reconnect')
    expect(classifyProviderFailure(new JiraRequestError(401, 'Unauthorized')).health).toBe('reconnect')
  })

  test('a refusal of this one source is no_access', () => {
    expect(classifyProviderFailure(Object.assign(new Error('Not Found'), { status: 404 })).health).toBe('no_access')
    expect(classifyProviderFailure(new JiraRequestError(403, 'Forbidden')).health).toBe('no_access')
    expect(classifyProviderFailure({ errors: [{ type: 'NOT_FOUND' }] }).health).toBe('no_access')
  })

  test('each other failure is error, with its own message', () => {
    expect(classifyProviderFailure(new Error('socket hang up'))).toEqual({ health: 'error', message: 'socket hang up' })
    expect(classifyProviderFailure(new JiraRequestError(500, 'Server error')).health).toBe('error')
  })

  test('a failed write carries the connect marker only for a connection problem', () => {
    expect(taskWriteError(new Error('GitHub is not connected')).message.startsWith(TASKS_AUTH_ERROR_PREFIX)).toBe(true)
    expect(taskWriteError(new Error('Validation Failed')).message).toBe('Validation Failed')
  })
})
