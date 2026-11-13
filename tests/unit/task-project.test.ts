import { describe, expect, test } from 'bun:test'
import { guessTaskProject, taskRepositoryKey } from '@solus/workspace-ui/lib/task-project'

// A task belongs to no project (docs/tasks.md). A session started from a task
// opens in a guess, which the person can change on the draft before Send.

const checkedOut = new Set(['github.com/acme/app'])
const hasConnectedCheckout = (projectKey: string) => checkedOut.has(projectKey)
const INPUT_BAR = 'github.com/acme/site'

describe('the project a session from a task starts in', () => {
  test('a GitHub issue opens in the checkout of its repository', () => {
    // WHY: the agent works where the issue's code is. The input bar can be in
    // another project, and a session there would change the wrong code.
    expect(guessTaskProject({ providerId: 'github', reference: 'acme/app#12' }, hasConnectedCheckout, INPUT_BAR))
      .toBe('github.com/acme/app')
    // A repository key is lowercase, as the project catalog keys it.
    expect(guessTaskProject({ providerId: 'github', reference: 'Acme/App#12' }, hasConnectedCheckout, INPUT_BAR))
      .toBe('github.com/acme/app')
  })

  test('a GitHub issue of a repository that no connected host has opens in the input bar\'s project', () => {
    // WHY: a project with no connected checkout has nowhere to run. The
    // project the person works in now is the better guess, and they can change it.
    expect(guessTaskProject({ providerId: 'github', reference: 'acme/unknown#3' }, hasConnectedCheckout, INPUT_BAR))
      .toBe(INPUT_BAR)
  })

  test('a Jira issue and a draft item open in the input bar\'s project', () => {
    // WHY: neither names a repository, so only the person's current project
    // is a guess.
    expect(guessTaskProject({ providerId: 'jira', reference: 'SOL-4' }, hasConnectedCheckout, INPUT_BAR)).toBe(INPUT_BAR)
    expect(guessTaskProject({ providerId: 'github' }, hasConnectedCheckout, INPUT_BAR)).toBe(INPUT_BAR)
    expect(guessTaskProject({ providerId: 'jira', reference: 'SOL-4' }, hasConnectedCheckout, null)).toBeNull()
  })
})

describe('the repository of a task', () => {
  test('only a GitHub issue reference names a repository', () => {
    expect(taskRepositoryKey({ providerId: 'github', reference: 'acme/app#12' })).toBe('github.com/acme/app')
    // A Jira key has the same `X-1` look as nothing GitHub writes, and no repository.
    expect(taskRepositoryKey({ providerId: 'jira', reference: 'SOL-4' })).toBeNull()
    expect(taskRepositoryKey({ providerId: 'github', reference: 'not a reference' })).toBeNull()
  })
})
