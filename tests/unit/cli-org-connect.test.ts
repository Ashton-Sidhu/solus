import { describe, expect, test } from 'bun:test'
import type { HostOrganizationsStatus } from '@solus/contracts/organization-scope'
import { parseLinkCode, type AccountOrganization, type UplinkStatus } from '@solus/contracts/uplink'
import type { CloudMachineRecord } from '../../apps/cli/src/lib/cloud-machine'
import type { ConnectChoice, ConnectionStatus, ConnectOptions, ConnectReporter } from '../../apps/cli/src/lib/connect'
import { describeConnection, describeSelfTest, onboard, type OnboardingDeps, type Provider } from '../../apps/cli/src/lib/onboarding'
import type { Choice, Prompter } from '../../apps/cli/src/lib/prompts'

// plans/034-one-cloud-machine-kind.md: `solus setup` is one command. A link code
// decides by itself and asks nothing. A terminal asks how the server will be used:
// pair directly, link to an account, or become a cloud host of an organization; then
// it offers provider sign-in, which can be skipped. A cloud host starts with new data.
// The code or the choice decides the kind; `--address` only says where the internet
// reaches the server, for both kinds. Without a terminal nothing is asked, no device
// sign-in waits, and no provider login starts. `solus connect` is the same steps.

const ORGANIZATIONS: AccountOrganization[] = [
  { organizationId: 'org_a', name: 'Acme', role: 'member', mayCreateManagedHost: false, hostRules: { allowsCloudHosts: true, allowsPersonalHosts: false } },
  { organizationId: 'org_b', name: 'Beta', role: 'owner', mayCreateManagedHost: false, hostRules: { allowsCloudHosts: true, allowsPersonalHosts: true } },
]
const UNREGISTERED: UplinkStatus = { registration: { registered: false }, link: { linked: false } }
const REGISTRATION = { hostId: 'h1', issuer: 'https://app.solus.sh', jwksUrl: 'https://app.solus.sh/api/auth/jwks', directoryUrl: 'https://app.solus.sh', generation: 1, apiUrl: 'https://solus-sh-api.fly.dev' }
const LINKED: UplinkStatus = {
  registration: { registered: true, registration: REGISTRATION, owner: { userId: 'u1', email: 'owner@example.test' } },
  link: { linked: true, tunnel: { hostname: 'h-h1.solus.sh', proxiedPort: 34118 }, state: { observed: 'online' } },
}
/** What `uplinkRegister` answers to an organization ticket: with an address the link is that address, without one a tunnel. */
const cloud = (address: string | undefined): UplinkStatus => ({
  registration: { registered: true, registration: { ...REGISTRATION, organizationId: 'org_b' }, owner: null },
  link: { linked: true, tunnel: { hostname: address ? new URL(address).host : 'h-h1.solus.sh', proxiedPort: 34118 }, state: { observed: 'online' } },
})
const CLOUD_RECORD: CloudMachineRecord = { registration: { ...REGISTRATION, organizationId: 'org_b' }, tunnel: { hostname: 'machine.example.com', proxiedPort: 34118 }, reach: 'direct' }
const standing = (overrides: Partial<HostOrganizationsStatus> = {}): HostOrganizationsStatus => ({
  registered: false, hostId: null, kind: 'personal', owner: null, organizations: [], insightsOptIn: [],
  apiUrl: null, delivery: [], deliveryError: null, ...overrides,
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

function fakeDeps(prompter: Prompter | null, current: ConnectionStatus = { uplink: UNREGISTERED, standing: standing(), reach: 'tunnel' }, cloudMachine: CloudMachineRecord | null = null) {
  const lines: string[] = []
  const connects: Array<{ options: ConnectOptions; choice: ConnectChoice | null }> = []
  const providers: Provider[] = []
  let state = current
  let statusReads = 0
  const deps: OnboardingDeps = {
    prompter,
    log: (line) => lines.push(line),
    connect: async (options: ConnectOptions, reporter: ConnectReporter) => {
      // A code, or an address for a registered server, asks nothing; else the real connect signs in and asks the reporter.
      const asksNothing = options.code !== undefined || (options.address !== undefined && state.uplink.registration.registered)
      const choice = asksNothing ? null : await reporter.choose(ORGANIZATIONS, state.uplink)
      connects.push({ options, choice })
      // The code or the choice makes a cloud host, never the address.
      if (options.code?.startsWith('org_') || choice?.kind === 'organization') return cloud(options.address)
      const link: UplinkStatus['link'] = options.address
        ? { linked: true, tunnel: { hostname: new URL(options.address).host, proxiedPort: 34118 }, state: { observed: 'online' } }
        : LINKED.link
      state = { uplink: { ...LINKED, link }, standing: standing({ registered: true, hostId: 'h1', apiUrl: 'https://solus-sh-api.fly.dev' }), reach: options.address ? 'direct' : 'tunnel' }
      return state.uplink
    },
    status: async () => { statusReads += 1; return state },
    cloudMachine: () => cloudMachine,
    pairLines: async () => ['PAIRING DETAILS'],
    setUpProvider: async (provider) => { providers.push(provider); return true },
  }
  return { deps, lines, connects, providers, statusReads: () => statusReads }
}

describe('solus setup and solus connect', () => {
  test('a personal link code links without a question and prints the live connection', async () => {
    const { deps, lines, connects } = fakeDeps(null)
    await onboard({ dataDir: '/tmp/solus-test', link: 'set_TICKET@app.solus.sh', mode: 'setup' }, deps)
    expect(connects).toEqual([{ options: { dataDir: '/tmp/solus-test', cloudUrl: undefined, noOpen: true, code: 'set_TICKET@app.solus.sh', address: undefined }, choice: null }])
    expect(lines.join('\n')).toContain('Server: h1 (Personal computer)')
    expect(lines.join('\n')).toContain('Tunnel: h-h1.solus.sh — online')
  })

  test('an organization code with an address makes a cloud host, and setup says what that is without a live read', async () => {
    const { deps, lines, connects, statusReads } = fakeDeps(null)
    await onboard({ dataDir: '/tmp/solus-test', link: 'org_ORG@app.solus.sh', address: 'https://machine.example.com', mode: 'setup' }, deps)
    expect(connects.map((call) => call.options)).toEqual([{ dataDir: '/tmp/solus-test', cloudUrl: undefined, noOpen: true, code: 'org_ORG@app.solus.sh', address: 'https://machine.example.com' }])
    const text = lines.join('\n')
    expect(text).toContain('This server is now a cloud host.')
    expect(text).toContain('Solus: cloud host of organization org_b')
    expect(text).toContain('Address: https://machine.example.com (it must forward to port 34118 on this machine)')
    expect(text).toContain('Members of the organization reach this server through Solus. It has no pairing code.')
    // WHY: a cloud host refuses the local socket, so a read after the registration would fail.
    expect(statusReads()).toBe(0)
  })

  test('an organization code with no address makes a cloud host with a tunnel, and setup names the tunnel', async () => {
    // WHY: the address is optional. Setup must not say "Address" for a host name that is a tunnel.
    const { deps, lines, connects, statusReads } = fakeDeps(null)
    await onboard({ dataDir: '/tmp/solus-test', link: 'org_ORG@app.solus.sh', mode: 'setup' }, deps)
    expect(connects.map((call) => call.options.address)).toEqual([undefined])
    const text = lines.join('\n')
    expect(text).toContain('This server is now a cloud host.')
    expect(text).toContain('  Tunnel: h-h1.solus.sh\n')
    expect(text).not.toContain('Address:')
    expect(statusReads()).toBe(0)
  })

  test('a personal code with an address stays a personal computer, reached at its address', async () => {
    const { deps, lines, connects } = fakeDeps(null)
    await onboard({ dataDir: '/tmp/solus-test', link: 'set_TICKET@app.solus.sh', address: 'https://machine.example.com', mode: 'connect' }, deps)
    expect(connects.map((call) => call.options.address)).toEqual(['https://machine.example.com'])
    const text = lines.join('\n')
    expect(text).toContain('Server: h1 (Personal computer)')
    expect(text).toContain('Address: https://machine.example.com (it must forward to port 34118 on this machine) — online')
    expect(text).not.toContain('cloud host')
  })

  test('a cloud host that Solus cloud did not link yet says why and what to do', async () => {
    const { deps, lines } = fakeDeps(null)
    deps.connect = async () => ({ ...cloud('https://machine.example.com'), link: { linked: false, error: 'Solus cloud is not reachable' } })
    await onboard({ dataDir: '/tmp/solus-test', link: 'org_ORG@app.solus.sh', address: 'https://machine.example.com', mode: 'connect' }, deps)
    expect(lines.join('\n')).toContain('Reachable from the internet: not yet (Solus cloud is not reachable). Restart the server so that it asks Solus cloud again.')
  })

  test('without a terminal nothing is asked or awaited: setup prints how to pair and how to link; connect refuses clearly', async () => {
    const { deps, lines, connects, providers } = fakeDeps(null)
    await onboard({ dataDir: '/tmp/solus-test', mode: 'setup' }, deps)
    expect(connects).toEqual([])
    expect(providers).toEqual([])
    expect(lines[0]).toBe('PAIRING DETAILS')
    expect(lines.join('\n')).toContain('solus setup --link CODE')
    // The address is an option of every link, not the mark of an organization.
    expect(lines.at(-1)).toBe('When this machine has its own HTTPS address, add `--address URL`: the internet reaches the server there. Without it the server gets a Cloudflare tunnel.')
    expect(lines.join('\n')).not.toMatch(/needs (its own|the) HTTPS address/)
    await expect(onboard({ dataDir: '/tmp/solus-test', mode: 'connect' }, deps)).rejects.toThrow(/needs a link code/)
  })

  test('an address without a code and without a terminal registers nothing, and setup says that the address was not used', async () => {
    const { deps, lines, connects } = fakeDeps(null)
    await onboard({ dataDir: '/tmp/solus-test', address: 'https://machine.example.com', mode: 'setup' }, deps)
    expect(connects).toEqual([])
    expect(lines.join('\n')).toContain('`--address` was not used')
  })

  test('on a registered server an address is the whole request: nothing is asked, also without a terminal, and the new reach is printed', async () => {
    // WHY: `solus connect --address URL` changes how the internet reaches a person's own server. It needs no code and no choice.
    for (const prompter of [null, scriptedPrompter([])]) {
      const { deps, lines, connects } = fakeDeps(prompter, { uplink: LINKED, standing: standing({ registered: true }), reach: 'tunnel' })
      await onboard({ dataDir: '/tmp/solus-test', address: 'https://machine.example.com', mode: 'connect' }, deps)
      expect(connects).toEqual([{ options: { dataDir: '/tmp/solus-test', cloudUrl: undefined, noOpen: true, code: undefined, address: 'https://machine.example.com' }, choice: null }])
      expect(prompter?.asked ?? []).toEqual([])
      expect(lines.join('\n')).toContain('Address: https://machine.example.com (it must forward to port 34118 on this machine) — online')
    }
  })

  test('in a terminal, an address does not choose the use: the person chooses the organization path, then which one, then each provider once', async () => {
    const prompter = scriptedPrompter(['organization', 'org_b', 'codex', 'skip'])
    const { deps, connects, providers } = fakeDeps(prompter)
    await onboard({ dataDir: '/tmp/solus-test', address: 'https://machine.example.com', mode: 'setup' }, deps)
    expect(prompter.asked).toEqual([
      'How will you use this server? [pair, account, organization, later]',
      'Which organization? [org_a, org_b]',
      'Set up an agent provider on this server? [claude-code, codex, skip]',
      'Set up an agent provider on this server? [claude-code, skip]',
    ])
    expect(connects.map((call) => call.choice)).toEqual([{ kind: 'organization', organizationId: 'org_b' }])
    expect(connects[0]!.options.address).toBe('https://machine.example.com')
    expect(providers).toEqual(['codex'])
  })

  test('choosing an organization without an address connects: the cloud host gets a tunnel', async () => {
    // WHY: this choice stopped with "needs its own HTTPS address" before the sign-in. The address is optional now.
    const prompter = scriptedPrompter(['organization', 'org_a', 'skip'])
    const { deps, lines, connects } = fakeDeps(prompter)
    await onboard({ dataDir: '/tmp/solus-test', mode: 'setup' }, deps)
    expect(connects).toEqual([{ options: { dataDir: '/tmp/solus-test', cloudUrl: undefined, noOpen: false, address: undefined }, choice: { kind: 'organization', organizationId: 'org_a' } }])
    expect(lines.join('\n')).toContain('  Tunnel: h-h1.solus.sh\n')
  })

  test('linking to an account keeps the server personal, and connect never offers pairing or providers', async () => {
    const prompter = scriptedPrompter(['account'])
    const { deps, connects, providers } = fakeDeps(prompter)
    await onboard({ dataDir: '/tmp/solus-test', mode: 'connect' }, deps)
    expect(prompter.asked).toEqual(['How will you use this server? [account, organization, later]'])
    expect(connects.map((call) => call.choice)).toEqual([{ kind: 'personal' }])
    expect(providers).toEqual([])
  })

  test('a registered server is not offered the cloud host choice, and is told why; running setup again changes nothing by default', async () => {
    const prompter = scriptedPrompter([''])
    const { deps, lines, connects } = fakeDeps(prompter, { uplink: LINKED, standing: standing({ registered: true }), reach: 'tunnel' })
    await onboard({ dataDir: '/tmp/solus-test', mode: 'setup' }, deps)
    expect(prompter.asked[0]).toBe('How will you use this server? [pair, later]')
    expect(lines[0]).toContain('cannot become a cloud host')
    expect(lines[0]).toContain('--data-dir')
    expect(connects).toEqual([])
  })

  test('the desktop app is a personal computer always: its solus never offers the cloud host choice', async () => {
    const prompter = scriptedPrompter(['later'])
    const { deps } = fakeDeps(prompter)
    await onboard({ dataDir: '/tmp/solus-test', mode: 'connect', isDesktopApp: true }, deps)
    expect(prompter.asked).toEqual(['How will you use this server? [account, later]'])
  })

  test('the solus of the desktop app refuses an organization code before any call: the code would make a cloud host of the app', async () => {
    const { deps, connects, statusReads } = fakeDeps(null)
    await expect(onboard({ dataDir: '/tmp/solus-test', link: 'org_ORG@app.solus.sh', mode: 'connect', isDesktopApp: true }, deps)).rejects.toThrow(/organization code.*desktop app is a personal computer always/)
    expect(connects).toEqual([])
    expect(statusReads()).toBe(0)
    // A personal code, with an address or without, is its ordinary link.
    await onboard({ dataDir: '/tmp/solus-test', link: 'set_ME@app.solus.sh', address: 'https://machine.example.com', mode: 'connect', isDesktopApp: true }, deps)
    expect(connects).toHaveLength(1)
  })

  test('a server that is a cloud host already answers no local call: setup prints its records and changes nothing', async () => {
    const { deps, lines, connects, statusReads } = fakeDeps(null, undefined, CLOUD_RECORD)
    await onboard({ dataDir: '/tmp/solus-test', link: 'org_OTHER@app.solus.sh', address: 'https://other.example.com', mode: 'setup' }, deps)
    expect(connects).toEqual([])
    expect(statusReads()).toBe(0)
    expect(lines[0]).toBe('Solus: cloud host of organization org_b')
    expect(lines.join('\n')).toContain('Nothing was changed: this server is a cloud host already, and the link code was not used.')
  })

  test('status of a personal server names the kind, the control plane, the API, the reach, and what waits, never a credential', () => {
    expect(describeConnection({ uplink: UNREGISTERED, standing: standing(), reach: 'tunnel' })).toEqual(['Solus: not registered. Clients connect to this server directly; its work stays here.'])
    const text = describeConnection({ uplink: LINKED, standing: standing({ registered: true, apiUrl: 'https://solus-sh-api.fly.dev', organizations: [{ organizationId: 'org_a', name: 'Acme', shared: true, hostRules: ORGANIZATIONS[0]!.hostRules }], delivery: [{ organizationId: 'org_a', pending: 3, failed: 1 }], deliveryError: 'The Solus API answered 503' }), reach: 'tunnel' }).join('\n')
    expect(text).toContain('Server: h1 (Personal computer)')
    expect(text).toContain('Control plane: https://app.solus.sh')
    expect(text).toContain('Solus API: https://solus-sh-api.fly.dev')
    expect(text).toContain('Waiting for Acme: 3 queued, 1 refused')
    expect(text).toContain('Last delivery error: The Solus API answered 503')
    expect(text).not.toMatch(/sht_|token|attach/i)
    expect(text).toContain('Solus: registered to owner@example.test')
    expect(text).toContain('Tunnel: h-h1.solus.sh — online')
    // Registered and not linked: the server is reached on its network, and says so.
    expect(describeConnection({ uplink: { ...LINKED, link: { linked: false } }, standing: standing({ registered: true }), reach: 'tunnel' }).join('\n')).toContain('Reachable from the internet: local network only (not linked)')
  })

  test('status prints the test of the connection: the stages, the facts, and the fix', () => {
    const text = describeSelfTest({
      selfTest: {
        checkedAt: 1,
        reachable: false,
        summary: 'Cloudflare\'s tunnel port (7844) does not answer from this machine.',
        stages: [{ stage: 'device', label: 'Other devices', result: 'unknown', detail: null }, { stage: 'tunnel', label: 'Tunnel', result: 'failed', detail: 'Port 7844' }],
        problem: { stage: 'tunnel', cause: 'edge-blocked', reason: 'blocked', fix: 'Allow outbound port 7844.', hint: 'A VPN can block this port.' },
        facts: [{ label: 'Port 7844', value: 'TCP blocked or timed out; UDP not tested' }],
      },
      selfTestError: null,
    }).join('\n')
    expect(text).toContain('Connection test: Cloudflare\'s tunnel port (7844) does not answer')
    expect(text).toContain('Other devices: Unknown')
    expect(text).toContain('Tunnel: Failed (Port 7844)')
    expect(text).toContain('Port 7844: TCP blocked or timed out; UDP not tested')
    expect(text).toContain('A VPN can block this port.')
    expect(text).toContain('Fix: Allow outbound port 7844.')
  })

  test('an older server says that the test could not run, not that it passed', () => {
    expect(describeSelfTest({ selfTest: null, selfTestError: 'unknown method' })[0]).toContain('could not run (unknown method)')
  })

  test('a link code names its own account plane; a bare ticket uses the one setup was given', () => {
    expect(parseLinkCode('set_ABC@app.solus.sh', 'https://staging.solus.sh')).toEqual({ ticket: 'set_ABC', directoryUrl: 'https://app.solus.sh' })
    expect(parseLinkCode('set_ABC', 'https://staging.solus.sh')).toEqual({ ticket: 'set_ABC', directoryUrl: 'https://staging.solus.sh' })
  })
})
