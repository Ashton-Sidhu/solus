import { describe, expect, test } from 'bun:test'
import type { HostReadiness } from '@solus/contracts/types'
import { githubFollowThroughFailure, hostStage, hostStageFooter, type HostStageInput, type HostStageStep } from '@solus/workspace-ui/components/servers/lib/host-stage'

// WHY: a new host is set up like first-run onboarding, without its projects:
// pair it, connect its agents first, then GitHub. One step is open at a time; a
// done step folds with Edit; Skip leaves a step for later and opens the next.

function readiness(overrides: { agent?: boolean; github?: boolean } = {}): HostReadiness {
  return {
    platform: 'linux',
    home: '/home/dev',
    projectsRoot: '/home/dev/projects',
    git: { installed: true, identity: null, credentialHelper: false },
    github: overrides.github
      ? { solusToken: true, solusLogin: 'dev', solusScopes: ['repo', 'read:org', 'gist', 'project'], ghCli: true, ghAuthenticated: false }
      : { solusToken: false, solusLogin: null, solusScopes: undefined, ghCli: true, ghAuthenticated: false },
    ssh: { publicKeys: [] },
    agents: { claude: { installed: true, signedIn: !!overrides.agent }, codex: { installed: false, signedIn: false }, agy: { installed: false, signedIn: false } },
    installGit: null,
    installGh: null,
  }
}

function input(overrides: Partial<HostStageInput> = {}): HostStageInput {
  return { isPairing: false, pairingView: 'connecting', pairingBusy: false, readiness: readiness(), runningStep: null, failedStep: null, skipped: new Set(), reopened: null, ...overrides }
}

const statuses = (stage: ReturnType<typeof hostStage>) => stage.entries.map((entry) => [entry.step, entry.status, entry.marker])

describe('the setup of a new host', () => {
  test('pairing is open first, with a spinner while it connects, and the other steps wait', () => {
    const stage = hostStage(input({ isPairing: true, readiness: null }))
    expect(stage.open).toBe('pair')
    expect(statuses(stage)).toEqual([['pair', 'open', 'spinner'], ['agents', 'next', 'number'], ['github', 'next', 'number']])
  })

  test('once paired, agents come before GitHub', () => {
    expect(hostStage(input()).open).toBe('agents')
    expect(hostStage(input({ readiness: readiness({ agent: true }) })).open).toBe('github')
    expect(hostStage(input({ readiness: readiness({ agent: true, github: true }) })).open).toBeNull()
  })

  test('a host that came with its agents and GitHub opens ready, with each step folded as done', () => {
    const stage = hostStage(input({ readiness: readiness({ agent: true, github: true }) }))
    expect(statuses(stage)).toEqual([['pair', 'done', 'check'], ['agents', 'done', 'check'], ['github', 'done', 'check']])
  })

  test('Skip leaves a step for later and opens the next; Edit opens a done step again', () => {
    const skipped = hostStage(input({ skipped: new Set<HostStageStep>(['agents']) }))
    expect(skipped.open).toBe('github')
    expect(skipped.entries[1]).toMatchObject({ status: 'done', marker: 'number' })
    const reopened = hostStage(input({ readiness: readiness({ agent: true }), reopened: 'agents' }))
    expect(reopened.open).toBe('agents')
  })

  test('the work that follows GitHub shows on its line: a spinner while it runs, a failure with its step to retry', () => {
    const done = readiness({ agent: true, github: true })
    expect(hostStage(input({ readiness: done, runningStep: 'gh-auth' })).entries[2]?.marker).toBe('spinner')
    expect(hostStage(input({ readiness: done, failedStep: 'credential-helper' })).entries[2]?.marker).toBe('failed')
    expect(githubFollowThroughFailure(done, { step: 'gh-auth', message: 'gh is not signed in' })).toEqual({ id: 'gh-auth', message: 'Authorize the gh CLI: gh is not signed in' })
    // A failed decision is not a follow-through: its own panel says why.
    expect(githubFollowThroughFailure(done, { step: 'providers', message: 'Sign-in failed' })).toBeNull()
  })

  test('the footer: Continue waits for its step, pairing names its action, and a ready host has only Done', () => {
    const none = new Set<HostStageStep>(['pair'])
    expect(hostStageFooter({ open: 'agents', hostName: 'sidhu', done: none, pairingAction: null })).toMatchObject({ primaryLabel: 'Continue', primaryEnabled: false, secondary: 'skip' })
    expect(hostStageFooter({ open: 'pair', hostName: 'sidhu', done: new Set(), pairingAction: { label: 'Connect', disabled: false } })).toMatchObject({ primaryLabel: 'Connect', primaryEnabled: true })
    expect(hostStageFooter({ open: 'pair', hostName: 'sidhu', done: new Set(), pairingAction: null }).primaryEnabled).toBe(false)
    expect(hostStageFooter({ open: null, hostName: 'sidhu', done: none, pairingAction: null })).toMatchObject({ primaryLabel: 'Done', primaryEnabled: true, secondary: null })
  })
})
