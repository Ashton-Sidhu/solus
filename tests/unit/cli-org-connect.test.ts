import { describe, expect, test } from 'bun:test'
import type { HostOrganizationsStatus } from '@solus/contracts/organization-scope'
import { parseLinkCode, type AccountOrganization, type UplinkStatus } from '@solus/contracts/uplink'
import type { ConnectOptions, ConnectReporter } from '../../apps/cli/src/lib/connect'
import { describeConnection, onboard, type OnboardingDeps, type Provider } from '../../apps/cli/src/lib/onboarding'
import type { Choice, Prompter } from '../../apps/cli/src/lib/prompts'

// plans/009-organization-vms.md §5: `solus setup` is one command. A link code
// decides by itself and asks nothing. A terminal asks how the server will be used:
// pair directly, link to an account, or attach to an organization; then it offers
// provider sign-in, which can be skipped. Without a terminal nothing is asked, no
// device sign-in waits, and no provider login starts. `solus connect` is the same
// linking steps.

const ORGANIZATIONS: AccountOrganization[] = [
  { organizationId: 'org_a', name: 'Acme', role: 'member', mayCreateManagedHost: false, policy: { allowsCloudHosts: true, allowsPersonalHosts: false, syncAllInsights: true } },
  { organizationId: 'org_b', name: 'Beta', role: 'owner', mayCreateManagedHost: false, policy: { allowsCloudHosts: true, allowsPersonalHosts: true, syncAllInsights: true } },
]
const UNLINKED: UplinkStatus = { linked: false }
const LINKED: UplinkStatus = { linked: true, link: { hostId: 'h1', issuer: 'https://app.solus.sh', jwksUrl: 'https://app.solus.sh/api/auth/jwks', directoryUrl: 'https://app.solus.sh', hostname: 'h-h1.solus.sh', proxiedPort: 34118, connectionGeneration: 1, apiUrl: 'https://solus-sh-api.fly.dev' }, state: { observed: 'online' } }
const standing = (overrides: Partial<HostOrganizationsStatus> = {}): HostOrganizationsStatus => ({
  linked: false, hostId: null, category: 'self-hosted', owner: null, organizations: [], insightsOptIn: [],
  attachedAt: null, apiUrl: null, delivery: [], deliveryError: null, ...overrides,
})

/** Answers each question from a script, and records what was asked. */
function scriptedPrompter(answers: string[]): Prompter & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    async choose<T extends string>(question: string, choices: Array<Choice<T>>, fallback: T): Promise<T> {
      asked.push(`${question} [${choices.map((choice) => choice.value).join(', ')}]`)
      const answer = answers.shift()
      return (choices.find((choice) => choice.value === answer)?.value ?? fallback)
    },
    close() {},
  }
}

function fakeDeps(prompter: Prompter | null, current = { link: UNLINKED, standing: standing() }) {
  const lines: string[] = []
  const connects: Array<{ options: ConnectOptions; choice: unknown }> = []
  const providers: Provider[] = []
  let state = current
  const deps: OnboardingDeps = {
    prompter,
    log: (line) => lines.push(line),
    connect: async (options: ConnectOptions, reporter: ConnectReporter) => {
      // Without a code the real connect signs in and asks the reporter; with one it asks nothing.
      const choice = options.code ? null : await reporter.choose(ORGANIZATIONS, state.link)
      connects.push({ options, choice })
      state = { link: LINKED, standing: standing({ linked: true, hostId: 'h1', attachedAt: choice && typeof choice === 'object' && 'organizationId' in choice ? 1 : options.code ? 1 : null, organizations: [{ organizationId: 'org_a', name: 'Acme', shared: true, policy: ORGANIZATIONS[0]!.policy }], apiUrl: 'https://solus-sh-api.fly.dev' }) }
      return state.link
    },
    status: async () => state,
    pairLines: async () => ['PAIRING DETAILS'],
    setUpProvider: async (provider) => { providers.push(provider); return true },
  }
  return { deps, lines, connects, providers }
}

describe('solus setup and solus connect', () => {
  test('a link code links or attaches without a question, and says what new work will be', async () => {
    const { deps, lines, connects } = fakeDeps(null)
    await onboard({ dataDir: '/tmp/solus-test', link: 'set_TICKET@app.solus.sh', mode: 'setup' }, deps)
    expect(connects).toEqual([{ options: { dataDir: '/tmp/solus-test', cloudUrl: undefined, noOpen: true, code: 'set_TICKET@app.solus.sh' }, choice: null }])
    expect(lines.join('\n')).toContain('New work here belongs to the organization')
    expect(lines.join('\n')).toContain('personal work already here stays on this server')
  })

  test('without a terminal nothing is asked or awaited: setup prints how to pair and how to link; connect refuses clearly', async () => {
    const { deps, lines, connects, providers } = fakeDeps(null)
    await onboard({ dataDir: '/tmp/solus-test', mode: 'setup' }, deps)
    expect(connects).toEqual([])
    expect(providers).toEqual([])
    expect(lines[0]).toBe('PAIRING DETAILS')
    expect(lines.join('\n')).toContain('solus setup --link CODE')
    await expect(onboard({ dataDir: '/tmp/solus-test', mode: 'connect' }, deps)).rejects.toThrow(/needs a link code/)
  })

  test('in a terminal, attaching to an organization asks which one and then offers each provider once, with Skip always available', async () => {
    const prompter = scriptedPrompter(['organization', 'org_b', 'codex', 'skip'])
    const { deps, connects, providers } = fakeDeps(prompter)
    await onboard({ dataDir: '/tmp/solus-test', mode: 'setup' }, deps)
    expect(prompter.asked).toEqual([
      'How will you use this server? [pair, account, organization, later]',
      'Which organization? [org_a, org_b]',
      'Set up an agent provider on this server? [claude-code, codex, skip]',
      'Set up an agent provider on this server? [claude-code, skip]',
    ])
    expect(connects.map((call) => call.choice)).toEqual([{ kind: 'organization', organizationId: 'org_b' }])
    expect(providers).toEqual(['codex'])
  })

  test('linking to an account keeps the server personal, and connect never offers pairing or providers', async () => {
    const prompter = scriptedPrompter(['account'])
    const { deps, connects, providers } = fakeDeps(prompter)
    await onboard({ dataDir: '/tmp/solus-test', mode: 'connect' }, deps)
    expect(prompter.asked).toEqual(['How will you use this server? [account, organization, later]'])
    expect(connects.map((call) => call.choice)).toEqual([{ kind: 'personal' }])
    expect(providers).toEqual([])
  })

  test('a linked server is offered another organization, not a second link; running setup again changes nothing by default', async () => {
    const prompter = scriptedPrompter([''])
    const { deps, connects } = fakeDeps(prompter, { link: LINKED, standing: standing({ linked: true, attachedAt: 5 }) })
    await onboard({ dataDir: '/tmp/solus-test', mode: 'setup' }, deps)
    expect(prompter.asked[0]).toBe('How will you use this server? [pair, organization, later]')
    expect(connects).toEqual([])
  })

  test('status names the kind, the attachment, the API, and what waits, never a credential', () => {
    expect(describeConnection({ link: UNLINKED, standing: standing() })).toEqual(['Solus: not linked. Clients connect to this server directly; its work stays here.'])
    const text = describeConnection({ link: LINKED, standing: standing({ linked: true, attachedAt: 1, apiUrl: 'https://solus-sh-api.fly.dev', organizations: [{ organizationId: 'org_a', name: 'Acme', shared: true, policy: ORGANIZATIONS[0]!.policy }], delivery: [{ organizationId: 'org_a', pending: 3, failed: 1 }], deliveryError: 'The Solus API answered 503' }) }).join('\n')
    expect(text).toContain('self-hosted server')
    expect(text).toContain('Organization work: Acme')
    expect(text).toContain('Solus API: https://solus-sh-api.fly.dev')
    expect(text).toContain('Waiting for Acme: 3 queued, 1 refused')
    expect(text).not.toMatch(/sht_|token/i)
    expect(describeConnection({ link: LINKED, standing: standing({ linked: true }) }).join('\n')).toContain('not attached. New work here stays on this server')
  })

  test('a link code names its own account plane; a bare ticket uses the one setup was given', () => {
    expect(parseLinkCode('set_ABC@app.solus.sh', 'https://staging.solus.sh')).toEqual({ ticket: 'set_ABC', directoryUrl: 'https://app.solus.sh' })
    expect(parseLinkCode('set_ABC', 'https://staging.solus.sh')).toEqual({ ticket: 'set_ABC', directoryUrl: 'https://staging.solus.sh' })
  })
})
