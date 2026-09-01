import { describe, expect, test } from 'bun:test'
import {
  githubUnavailableReason,
  jiraUnavailableReason,
  taskProviderLabel,
  taskProviderTrigger,
} from '@solus/workspace-ui/components/tasks/provider/lib/task-provider'

describe('when GitHub can be chosen', () => {
  test('requires the checkout underlying GitHub repository', () => {
    // WHY: the picker must not become an arbitrary GitHub repository browser.
    expect(githubUnavailableReason(null)).toBe('Add a GitHub origin remote first')
    expect(githubUnavailableReason({ owner: 'acme', repo: 'product' })).toBeNull()
  })
})

/**
 * What the task-provider picker says when Jira is not offerable. The whole
 * point of this control is that a user can tell why an option is missing, so a
 * wrong reason is worse than no reason.
 */

const reachable = { connected: true, reachesJira: true, loading: false, error: null }

describe('why Jira cannot be chosen', () => {
  test('a failed read outranks any guess about an empty list', () => {
    // WHY: this is the bug that made a dead Atlassian grant read as "no Jira
    // projects on the connected site" — a confident, wrong answer that sent the
    // user looking at their Jira site instead of at their connection.
    expect(jiraUnavailableReason({
      ...reachable,
      projectCount: 0,
      error: 'The Atlassian connection is not usable. Sign in again.',
    })).toBe('The Atlassian connection is not usable. Sign in again.')
  })

  test('an empty list is only ever reported when the read succeeded', () => {
    expect(jiraUnavailableReason({ ...reachable, projectCount: 0 }))
      .toBe('No Jira projects on the connected site')
  })

  test('says nothing while the list is still loading', () => {
    // WHY: "no projects" during the fetch is a lying empty state.
    expect(jiraUnavailableReason({ ...reachable, projectCount: 0, loading: true })).toBeNull()
  })

  test('names the missing connection before blaming the site', () => {
    expect(jiraUnavailableReason({ ...reachable, connected: false, projectCount: 0 }))
      .toBe('Connect Atlassian in Settings first')
    expect(jiraUnavailableReason({ ...reachable, reachesJira: false, projectCount: 0 }))
      .toBe('This Atlassian connection does not reach Jira')
  })

  test('blocks nothing once projects are listed', () => {
    expect(jiraUnavailableReason({ ...reachable, projectCount: 3 })).toBeNull()
  })
})

describe('what the control is labelled', () => {
  test('names the Jira project, because that is what tells two bindings apart', () => {
    expect(taskProviderLabel('jira', 'ACME')).toBe('Jira · ACME')
  })

  test('names the pinned GitHub repository', () => {
    expect(taskProviderLabel('github', 'owner/repo')).toBe('GitHub · owner/repo')
    expect(taskProviderLabel('local', null)).toBe('Local tasks')
  })
})

/**
 * The header control is the only place a project's task provider is chosen, so
 * it has to read as a decision when none has been made — not as a setting that
 * is already correct.
 */
describe('how the header control presents itself', () => {
  test('a project with no upstream invites a connection', () => {
    const trigger = taskProviderTrigger('local', null, null)
    expect(trigger.unbound).toBe(true)
    expect(trigger.label).toBe('Connect provider')
    expect(trigger.title).toBe('Tasks live only in Solus. Sync them with GitHub or Jira.')
  })

  test('a detected repository is named in the tooltip, never in the label', () => {
    // WHY: clicking opens the menu; it does not bind. A label that named the
    // repository would promise a binding the click does not perform.
    const trigger = taskProviderTrigger('local', null, { owner: 'acme', repo: 'product' })
    expect(trigger.label).toBe('Connect provider')
    expect(trigger.title).toContain('acme/product')
  })

  test('a bound project reports its scope instead of inviting', () => {
    const trigger = taskProviderTrigger('jira', 'ACME', null)
    expect(trigger.unbound).toBe(false)
    expect(trigger.label).toBe('Jira · ACME')
  })
})
