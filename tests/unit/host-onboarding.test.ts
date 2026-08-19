import { describe, expect, test } from 'bun:test'
import type { HostReadiness } from '@solus/contracts/types'
import {
  codingProviderRows,
  gitHostRows,
  hostCarriedOverFacts,
  hostOnboardingSteps,
  hostReadinessSummary,
  onboardingRailModel,
  providerSetupActions,
} from '@solus/workspace-ui/components/servers/lib/host-onboarding'

function readiness(overrides: Partial<HostReadiness> = {}): HostReadiness {
  return {
    platform: 'linux',
    home: '/home/dev',
    projectsRoot: '/home/dev/projects',
    git: { installed: true, identity: null, credentialHelper: false },
    github: {
      solusToken: false,
      solusLogin: null,
      solusScopes: undefined,
      ghCli: true,
      ghAuthenticated: false,
    },
    ssh: { publicKeys: [] },
    agents: { claude: { installed: false, signedIn: false }, codex: { installed: false, signedIn: false } },
    installGit: null,
    installGh: null,
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
      'gh-cli',
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
      readiness: readiness({
        github: {
          solusToken: true,
          solusLogin: 'dev',
          solusScopes: ['repo', 'read:org', 'gist', 'project'],
          ghCli: true,
          ghAuthenticated: false,
        },
      }),
    })
    expect(stepFor(connected, 'credential-helper').blockedBy).toBeNull()
    expect(stepFor(connected, 'gh-auth').blockedBy).toBeNull()
  })

  test('authorizing gh waits on gh itself, not just on the token', () => {
    // WHY: `gh auth login` on a host without the binary can only fail with "the
    // GitHub CLI is not installed", which tells the user nothing about the fix.
    const steps = hostOnboardingSteps({
      readiness: readiness({
        github: {
          solusToken: true,
          solusLogin: 'dev',
          solusScopes: ['repo', 'read:org', 'gist', 'project'],
          ghCli: false,
          ghAuthenticated: false,
        },
      }),
    })
    expect(stepFor(steps, 'gh-cli').done).toBe(false)
    expect(stepFor(steps, 'gh-cli').blockedBy).toBeNull()
    expect(stepFor(steps, 'gh-auth').blockedBy).toBe('gh-cli')
  })

  test('a host without the gh CLI can still take a session', () => {
    // WHY: `gh` only matters when the agent opens a pull request. Blocking on it
    // would hold back a host that is otherwise ready to run.
    const steps = hostOnboardingSteps({
      readiness: readiness({
        github: {
          solusToken: true,
          solusLogin: 'dev',
          solusScopes: ['repo', 'read:org', 'gist', 'project'],
          ghCli: false,
          ghAuthenticated: false,
        },
        agents: { claude: { installed: true, signedIn: true }, codex: { installed: false, signedIn: false } },
      }),
    })
    expect(hostReadinessSummary(steps).ready).toBe(true)
  })

  test('git and commit identity are repaired at the point of use, not during onboarding', () => {
    // WHY: coding hosts normally already have git, and identity is irrelevant
    // until the first commit. Exceptional hosts get an actionable repair where
    // the failed operation provides context.
    const steps = hostOnboardingSteps({
      readiness: readiness({ git: { installed: false, identity: null, credentialHelper: false } }),
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
      'gh-cli',
      'gh-auth',
    ])
  })

  test('one authenticated provider completes the combined provider step', () => {
    // WHY: a host only needs one runnable provider to take a session, while the
    // expanded row can still offer the other provider later.
    const steps = hostOnboardingSteps({
      readiness: readiness({
        git: { installed: true, identity: null, credentialHelper: true },
        github: {
          solusToken: true,
          solusLogin: 'dev',
          solusScopes: ['repo', 'read:org', 'gist', 'project'],
          ghCli: true,
          ghAuthenticated: true,
        },
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
          identity: { name: 'dev', email: 'dev@example.com' },
          credentialHelper: false,
        },
      }),
      hostName: 'gpu-01',
    })
    expect(factFor(facts, 'git').done).toBe(true)
    expect(factFor(facts, 'git').title).toBe('git is already here')
    expect(factFor(facts, 'identity').done).toBe(true)
    expect(factFor(facts, 'identity').detail).toBe('dev · dev@example.com')
  })

  test('a host missing git keeps the row and marks it undone rather than dropping it', () => {
    // WHY: a shorter list reads as "nothing to know here". The gap has to stay
    // visible, because it is what stops this host cloning anything later.
    const facts = hostCarriedOverFacts({
      readiness: readiness({
        git: { installed: false, identity: null, credentialHelper: false },
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
        git: { installed: false, identity: null, credentialHelper: true },
        github: {
          solusToken: true,
          solusLogin: 'dev',
          solusScopes: ['repo', 'read:org', 'gist', 'project'],
          ghCli: true,
          ghAuthenticated: true,
        },
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

describe('onboarding rail model', () => {
  test('a blocking failure stays on the decision that can repair it', () => {
    // WHY: the sidebar and main panel must not route independently and leave a
    // failed provider setup looking like the rail advanced past the blocker.
    const model = onboardingRailModel({
      readiness: readiness({
        github: {
          solusToken: true,
          solusLogin: 'dev',
          solusScopes: ['repo', 'read:org', 'gist', 'project'],
          ghCli: true,
          ghAuthenticated: true,
        },
      }),
      hostName: 'gpu-01',
      stepError: {
        step: 'providers',
        provider: 'claude',
        message: 'Sign-in failed',
      },
    })

    expect(model.current?.id).toBe('providers')
    expect(model.failure?.message).toBe('Sign-in failed')
    expect(model.doneDecisions.map((step) => step.id)).not.toContain('providers')
  })

  test('decisions carry extra progress weight because they cost user attention', () => {
    // WHY: four facts copied automatically must not make the rail look nearly
    // finished while both account decisions still need the user.
    const model = onboardingRailModel({
      readiness: readiness(),
      hostName: 'gpu-01',
    })

    expect(model.carriedDone).toBe(4)
    expect(model.carriedTotal).toBe(7)
    expect(model.percentDone).toBe(36)
  })
})

describe('provider choice rows', () => {
  const noop = () => {}

  test('the connected git host reports the account rather than an invitation to connect again', () => {
    const [github] = gitHostRows({
      readiness: readiness({
        github: {
          solusToken: true,
          solusLogin: 'dev',
          solusScopes: ['repo', 'read:org', 'gist', 'project'],
          ghCli: true,
          ghAuthenticated: true,
        },
      }),
      connecting: false,
      busy: false,
      connect: noop,
    })
    expect(github.state).toBe('done')
    expect(github.detail).toContain('dev')
  })

  test('a token missing gh CLI scopes offers a reconnect instead of a dead-end checkmark', () => {
    // WHY: gh rejects imported tokens without read:org and gist. Existing Solus
    // tokens must expose the one action that can mint a compatible replacement.
    const [github] = gitHostRows({
      readiness: readiness({
        github: {
          solusToken: true,
          solusLogin: 'dev',
          solusScopes: ['repo', 'project'],
          ghCli: true,
          ghAuthenticated: false,
        },
      }),
      connecting: false,
      busy: false,
      connect: noop,
    })
    expect(github.state).toBe('available')
    expect(github.actionLabel).toBe('Reconnect')
  })

  test('each provider remains independently actionable while another installs', () => {
    // WHY: users may set up both agents at once; one provider's progress must
    // not disable an unrelated install or sign-in.
    const rows = codingProviderRows({
      readiness: readiness(),
      stages: { claude: 'install', codex: null },
      add: noop,
    })
    const claude = rows.find((row) => row.id === 'claude')!
    const codex = rows.find((row) => row.id === 'codex')!
    expect(claude.state).toBe('busy')
    expect(codex.disabled).not.toBe(true)
    expect(codex.run).toBeDefined()
  })
})

describe('host setup sessions', () => {
  test('every surface asking about a host gets the same session and the same readiness', async () => {
    // WHY: the onboarding rail and the host page in settings both run setup on
    // a host. Two copies of this state would let one of them offer "Connect
    // GitHub" on a host the other had just connected, and let closing one
    // abandon an install the other started.
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    const { hostSetupStore } = await import(
      '@solus/workspace-ui/components/servers/host-setup.store.svelte'
    )

    expect(hostSetupStore.sessionFor('gpu-01')).toBe(hostSetupStore.sessionFor('gpu-01'))
    expect(hostSetupStore.sessionFor('gpu-01')).not.toBe(hostSetupStore.sessionFor('gpu-02'))

    hostSetupStore.readinessByHost['gpu-01'] = readiness({
      github: {
        solusToken: true,
        solusLogin: 'dev',
        solusScopes: ['repo', 'read:org', 'gist', 'project'],
        ghCli: true,
        ghAuthenticated: true,
      },
    })
    expect(hostSetupStore.sessionFor('gpu-01').readiness?.github.solusLogin).toBe('dev')
    // What the directory row reads off the store is what the session reports.
    expect(hostSetupStore.stepsFor('gpu-01')).toEqual(hostSetupStore.sessionFor('gpu-01').steps)
    expect(stepFor(hostSetupStore.sessionFor('gpu-01').steps, 'github').done).toBe(true)
    expect(stepFor(hostSetupStore.stepsFor('gpu-02'), 'github').done).toBe(false)

    delete (globalThis as unknown as { $state?: unknown }).$state
  })

  test('an older host never receives the GitHub CLI install method it does not support', async () => {
    // WHY: older hosts report that `gh` is missing but omit both `installGh`
    // and `setupInstallGh`; sending the newer method only produces an opaque
    // "Unknown method" error.
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    const { HostSetupSession } = await import(
      '@solus/workspace-ui/components/servers/host-setup.store.svelte'
    )
    let installCalls = 0
    const legacyReadiness = readiness({
      github: {
        solusToken: true,
        solusLogin: 'dev',
        solusScopes: ['repo', 'read:org', 'gist', 'project'],
        ghCli: false,
        ghAuthenticated: false,
      },
    }) as HostReadiness & { installGh?: HostReadiness['installGh'] }
    delete legacyReadiness.installGh
    const store = {
      readinessByHost: { legacy: legacyReadiness },
      resolveApi: () => ({
        setupInstallGh: async () => {
          installCalls += 1
        },
      }),
    }
    const setup = new HostSetupSession('legacy', store as never)

    expect(setup.canInstallGh).toBe(false)
    await setup.installGh()
    expect(installCalls).toBe(0)
    expect(setup.stepError?.message).toContain('Update Solus on this host')

    delete (globalThis as unknown as { $state?: unknown }).$state
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

  test('a signed-in provider can still be signed in again on request', () => {
    // WHY: readiness reports what the host's CLI last said, and credentials
    // expire without anything on the host noticing. A user who suspects a stale
    // token — or wants a different account — has to be able to re-run the flow
    // without first uninstalling the CLI.
    expect(providerSetupActions({ installed: true, signedIn: true }, { force: true })).toEqual([
      'authenticate',
    ])
    // Forcing never skips the install a missing CLI still needs.
    expect(providerSetupActions({ installed: false, signedIn: false }, { force: true })).toEqual([
      'install',
      'authenticate',
    ])
  })

  test('a signed-in row offers a forced sign-in beside its check mark', () => {
    // WHY: the settled row used to render a check mark and nothing else, so the
    // one flow that repairs an expired sign-in was unreachable from the only
    // surface that shows the provider's state.
    const calls: Array<[string, { force?: boolean } | undefined]> = []
    const rows = codingProviderRows({
      readiness: readiness({
        agents: {
          claude: { installed: true, signedIn: true },
          codex: { installed: false, signedIn: false },
        },
      }),
      stages: { claude: null, codex: null },
      add: (agent, opts) => calls.push([agent, opts]),
    })
    const claude = rows.find((row) => row.id === 'claude')!
    expect(claude.state).toBe('done')
    expect(claude.secondary?.label).toBe('Sign in again')
    claude.secondary!.run()
    expect(calls).toEqual([['claude', { force: true }]])
    // A provider that was never set up keeps its primary action and gains no
    // second one to choose between.
    expect(rows.find((row) => row.id === 'codex')!.secondary).toBeUndefined()
  })
})
