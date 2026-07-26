import { describe, expect, test } from 'bun:test'
import type { HostReadiness } from '../../src/shared/types'
import {
  codingProviderRows,
  gitHostRows,
  hostCarriedOverFacts,
  hostOnboardingSteps,
  hostReadinessSummary,
  providerSetupActions,
} from '../../src/renderer/components/servers/lib/host-onboarding'

function readiness(overrides: Partial<HostReadiness> = {}): HostReadiness {
  return {
    platform: 'linux',
    home: '/home/dev',
    projectsRoot: '/home/dev/projects',
    git: { installed: true, version: 'git 2.44', identity: null, credentialHelper: false },
    github: { solusToken: false, solusLogin: null, ghCli: true, ghAuthenticated: false },
    ssh: { publicKeys: [] },
    agents: { claude: { installed: false, signedIn: false }, codex: { installed: false, signedIn: false } },
    installGit: null,
    ...overrides,
  }
}

function stepFor(steps: ReturnType<typeof hostOnboardingSteps>, id: string) {
  return steps.find((step) => step.id === id)!
}

describe('host onboarding order', () => {
  test('the rail contains only authentication choices and their automatic follow-through', () => {
    // WHY: host naming, clone location, git and commit identity all have defaults
    // or contextual repairs; onboarding should not present them as decisions.
    expect(hostOnboardingSteps({ readiness: readiness() }).map((step) => step.id)).toEqual([
      'github',
      'credential-helper',
      'gh-auth',
      'providers',
    ])
  })

  test('the credential helper and gh auth wait for GitHub, not the other way round', () => {
    // WHY: both hand the stored token to something and throw outright without
    // one, so GitHub cannot float later in the list the way a user would guess.
    const steps = hostOnboardingSteps({ readiness: readiness() })
    expect(stepFor(steps, 'credential-helper').blockedBy).toBe('github')
    expect(stepFor(steps, 'gh-auth').blockedBy).toBe('github')

    const connected = hostOnboardingSteps({
      readiness: readiness({ github: { solusToken: true, solusLogin: 'dev', ghCli: true, ghAuthenticated: false } }),
    })
    expect(stepFor(connected, 'credential-helper').blockedBy).toBeNull()
    expect(stepFor(connected, 'gh-auth').blockedBy).toBeNull()
  })

  test('git and commit identity are repaired at the point of use, not during onboarding', () => {
    // WHY: coding hosts normally already have git, and identity is irrelevant
    // until the first commit. Exceptional hosts get an actionable repair where
    // the failed operation provides context.
    const steps = hostOnboardingSteps({
      readiness: readiness({ git: { installed: false, version: null, identity: null, credentialHelper: false } }),
    })
    expect(steps.map((step) => step.id)).not.toContain('git')
    expect(steps.map((step) => step.id)).not.toContain('identity')
  })

  test('only the steps needing a decision ask for one', () => {
    // WHY: provider choice and authentication belong together; token plumbing
    // has nothing to decide and should run without another interrogation.
    const steps = hostOnboardingSteps({ readiness: readiness() })
    expect(steps.filter((step) => step.automatic).map((step) => step.id)).toEqual([
      'credential-helper',
      'gh-auth',
    ])
  })

  test('one authenticated provider completes the combined provider step', () => {
    // WHY: a host only needs one runnable provider to take a session, while the
    // expanded row can still offer the other provider later.
    const steps = hostOnboardingSteps({
      readiness: readiness({
        git: { installed: true, version: 'git 2.44', identity: null, credentialHelper: true },
        github: { solusToken: true, solusLogin: 'dev', ghCli: true, ghAuthenticated: true },
        agents: { claude: { installed: true, signedIn: true }, codex: { installed: false, signedIn: false } },
      }),
    })
    expect(steps.every((step) => step.done)).toBe(true)
    expect(stepFor(steps, 'providers').done).toBe(true)
  })
})

describe('carried over facts', () => {
  function factFor(facts: ReturnType<typeof hostCarriedOverFacts>, id: string) {
    return facts.find((fact) => fact.id === id)!
  }

  test('what pairing already settled is reported back, so the user sees what it did not cost them', () => {
    // WHY: the stage's premise is that the host is mostly ready already. Git and
    // a commit identity the host came with have to read as carried over, or the
    // user assumes they are still owed work.
    const facts = hostCarriedOverFacts({
      readiness: readiness({
        git: {
          installed: true,
          version: 'git 2.44',
          identity: { name: 'dev', email: 'dev@example.com' },
          credentialHelper: false,
        },
      }),
      hostName: 'gpu-01',
    })
    expect(factFor(facts, 'git').done).toBe(true)
    expect(factFor(facts, 'git').title).toContain('git 2.44')
    expect(factFor(facts, 'identity').done).toBe(true)
    expect(factFor(facts, 'identity').detail).toBe('dev · dev@example.com')
  })

  test('a host missing git keeps the row and marks it undone rather than dropping it', () => {
    // WHY: a shorter list reads as "nothing to know here". The gap has to stay
    // visible, because it is what stops this host cloning anything later.
    const facts = hostCarriedOverFacts({
      readiness: readiness({
        git: { installed: false, version: null, identity: null, credentialHelper: false },
        installGit: { display: 'apt install git', autoRunnable: false },
      }),
      hostName: 'gpu-01',
    })
    expect(factFor(facts, 'git').done).toBe(false)
    expect(factFor(facts, 'git').detail).toBe('apt install git')
    expect(factFor(facts, 'identity').done).toBe(false)
  })
})

describe('host readiness summary', () => {
  test('missing git and commit identity do not make onboarding incomplete', () => {
    // WHY: readiness in the host directory reflects outstanding user choices;
    // operational failures are repaired when clone or commit is attempted.
    const steps = hostOnboardingSteps({
      readiness: readiness({
        git: { installed: false, version: null, identity: null, credentialHelper: true },
        github: { solusToken: true, solusLogin: 'dev', ghCli: true, ghAuthenticated: true },
        agents: { claude: { installed: true, signedIn: true }, codex: { installed: false, signedIn: false } },
      }),
    })
    const summary = hostReadinessSummary(steps)
    expect(summary.ready).toBe(true)
    expect(summary.remaining).toBe(0)
  })

  test('a host with no authenticated provider cannot take a session, so it is not ready', () => {
    const steps = hostOnboardingSteps({ readiness: readiness() })
    expect(hostReadinessSummary(steps).ready).toBe(false)
  })
})

describe('provider choice rows', () => {
  const noop = () => {}

  test('a git host Solus cannot connect yet is still listed, marked unsupported', () => {
    // WHY: a user looking for GitLab has to learn that Solus knows about it and
    // cannot use it yet. Omitting the row answers the same question with silence,
    // which reads as "this app only ever works with GitHub".
    const rows = gitHostRows({
      readiness: readiness(),
      connecting: false,
      busy: false,
      connect: noop,
    })
    expect(rows.map((row) => row.id)).toEqual(['github', 'gitlab', 'bitbucket'])
    expect(rows.filter((row) => row.state === 'unsupported').map((row) => row.id)).toEqual([
      'gitlab',
      'bitbucket',
    ])
    // An unsupported row must not be pressable, however it ends up drawn.
    expect(rows.filter((row) => row.state === 'unsupported').every((row) => !row.run)).toBe(true)
  })

  test('the connected git host reports the account rather than an invitation to connect again', () => {
    const [github] = gitHostRows({
      readiness: readiness({
        github: { solusToken: true, solusLogin: 'dev', ghCli: true, ghAuthenticated: true },
      }),
      connecting: false,
      busy: false,
      connect: noop,
    })
    expect(github.state).toBe('done')
    expect(github.detail).toContain('dev')
  })

  test('a provider being added holds the whole card still, so two installs cannot overlap', () => {
    // WHY: the host runs one setup command at a time; a second Add would fail on
    // a lock the user never sees.
    const rows = codingProviderRows({
      readiness: readiness(),
      inFlight: 'claude',
      stage: 'install',
      busy: true,
      add: noop,
    })
    const claude = rows.find((row) => row.id === 'claude')!
    const codex = rows.find((row) => row.id === 'codex')!
    expect(claude.state).toBe('busy')
    expect(codex.disabled).toBe(true)
  })

  test('an unsupported coding provider is listed beside the ones that work', () => {
    const rows = codingProviderRows({
      readiness: readiness(),
      inFlight: null,
      stage: null,
      busy: false,
      add: noop,
    })
    expect(rows.map((row) => row.id)).toEqual(['claude', 'codex', 'opencode'])
    expect(rows.find((row) => row.id === 'opencode')!.state).toBe('unsupported')
  })
})

describe('provider setup action', () => {
  test('a missing provider is installed and then authenticated in one action', () => {
    // WHY: "Add provider" promises a usable provider, not merely a CLI binary
    // that surprises the user with another sign-in step afterwards.
    expect(providerSetupActions({ installed: false, signedIn: false })).toEqual([
      'install',
      'authenticate',
    ])
    expect(providerSetupActions({ installed: true, signedIn: false })).toEqual(['authenticate'])
    expect(providerSetupActions({ installed: true, signedIn: true })).toEqual([])
  })
})
