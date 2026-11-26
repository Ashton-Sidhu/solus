import { describe, expect, test } from 'bun:test'
import { chooseRunOnHost } from '@solus/workspace-ui/contexts/projects/run-on-rule'

// docs/plans/project-model.md §6: a cloud task's session runs where the project
// was last worked on, if that machine is up; else on the organization's cloud
// host; never on a machine the rule cannot justify.

const laptop = { serverId: 'laptop', projectRoot: '/Users/me/web' }
const linux = { serverId: 'linux', projectRoot: '/home/me/web' }

describe('chooseRunOnHost', () => {
  test('the most recently used checkout on a host that is up', () => {
    expect(chooseRunOnHost([laptop, linux], [
      { serverId: 'laptop', online: false, cloud: false, hasManagedCompute: false },
      { serverId: 'linux', online: true, cloud: false, hasManagedCompute: false },
      { serverId: 'cloud', online: true, cloud: true, hasManagedCompute: true },
    ])).toEqual({ serverId: 'linux', path: '/home/me/web' })
  })

  test('the cloud host, with no checkout yet, when every checkout is off', () => {
    // WHY: a web user's laptop being asleep must not stop cloud work; the cloud
    // host clones the repository on Send.
    expect(chooseRunOnHost([laptop], [
      { serverId: 'laptop', online: false, cloud: false, hasManagedCompute: false },
      { serverId: 'cloud', online: true, cloud: true, hasManagedCompute: true },
    ])).toEqual({ serverId: 'cloud', path: null })
  })

  test('a stopped Cloud host is still the choice', () => {
    // WHY: with every machine off, the Cloud host is the only place the work can
    // run; a stopped one starts on Send rather than leaving the draft hostless.
    expect(chooseRunOnHost([laptop], [
      { serverId: 'laptop', online: false, cloud: false, hasManagedCompute: false },
      { serverId: 'cloud', online: false, cloud: true, hasManagedCompute: true },
    ])).toEqual({ serverId: 'cloud', path: null })
  })

  test('a cloud host that its operator runs is the choice while it answers, and never while it is down', () => {
    // WHY: Send can start only compute that Solus Cloud operates. A draft that points
    // at an operator's machine that is down would wait for a start nobody can make.
    expect(chooseRunOnHost([laptop], [
      { serverId: 'laptop', online: false, cloud: false, hasManagedCompute: false },
      { serverId: 'operator', online: true, cloud: true, hasManagedCompute: false },
    ])).toEqual({ serverId: 'operator', path: null })
    expect(chooseRunOnHost([laptop], [
      { serverId: 'laptop', online: false, cloud: false, hasManagedCompute: false },
      { serverId: 'operator', online: false, cloud: true, hasManagedCompute: false },
    ])).toBeNull()
  })

  test('a host the person just chose outranks a more recent checkout elsewhere', () => {
    // WHY: cloud onboarding asks where agents run, then which project. Landing
    // the project on the laptop because it holds an older checkout ignores the
    // answer the person gave one step earlier.
    expect(chooseRunOnHost([laptop], [
      { serverId: 'laptop', online: true, cloud: false, hasManagedCompute: false },
      { serverId: 'cloud', online: true, cloud: true, hasManagedCompute: true },
    ], 'cloud')).toEqual({ serverId: 'cloud', path: null })
  })

  test('a chosen host that cannot take the project falls back to the rule', () => {
    // WHY: a personal machine with no checkout cannot clone; the preference
    // must not leave the draft hostless when the rule has an answer.
    expect(chooseRunOnHost([laptop], [
      { serverId: 'laptop', online: true, cloud: false, hasManagedCompute: false },
      { serverId: 'other', online: true, cloud: false, hasManagedCompute: false },
    ], 'other')).toEqual({ serverId: 'laptop', path: '/Users/me/web' })
  })

  test('no choice rather than a machine that holds nothing and is not the Cloud host', () => {
    expect(chooseRunOnHost([laptop], [
      { serverId: 'laptop', online: false, cloud: false, hasManagedCompute: false },
      { serverId: 'other', online: true, cloud: false, hasManagedCompute: false },
    ])).toBeNull()
  })
})
