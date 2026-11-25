import type { DeviceCodeGrant } from '@solus/client-core/device-authorization'
import type { HostOrganizationsStatus } from '@solus/contracts/organization-scope'
import type { AccountOrganization, MachineKind, UplinkStatus } from '@solus/contracts/uplink'
import { connectionStageLine } from '@solus/contracts/host-connection'
import type { CloudMachineRecord } from './cloud-machine'
import { ADDRESS_NEEDED, type ConnectChoice, type ConnectOptions, type ConnectReporter, type ConnectSelfTest } from './connect'
import type { Prompter } from './prompts'

/**
 * What `solus setup` does after the service is healthy, and what `solus connect`
 * repeats (plans/034-one-cloud-machine-kind.md). A link code decides everything by
 * itself. Without one, a terminal asks: pair a client directly, link to the person's
 * account for discovery and remote access, or make the server a cloud host of an
 * organization. A cloud host needs its own HTTPS address (`--address`), works for that
 * one organization, and starts with new data, so a server that is registered already
 * is not offered that choice. Without a terminal, nothing is asked and nothing waits:
 * the pairing details are printed, with how to link.
 */

export type Provider = 'claude-code' | 'codex'

export interface OnboardingOptions {
  dataDir: string
  cloudUrl?: string
  /** A link code: connects without a question. */
  link?: string
  /** This machine's own HTTPS address: the server becomes a cloud host of an organization. */
  address?: string
  /** `connect` asks only how to link; `setup` also offers direct pairing and provider sign-in. */
  mode: 'setup' | 'connect'
  /** Do not open a browser for sign-in; the page and code are printed either way. */
  noOpen?: boolean
  /** The `solus` of the desktop app: its server is a personal computer always, so a cloud host is not offered. */
  isDesktopApp?: boolean
}

export interface OnboardingDeps {
  /** Null without a terminal: nothing is asked, no provider sign-in starts. */
  prompter: Prompter | null
  log(line: string): void
  connect(options: ConnectOptions, reporter: ConnectReporter): Promise<UplinkStatus>
  status(dataDir: string): Promise<{ uplink: UplinkStatus; standing: HostOrganizationsStatus }>
  /** The records of a server that is a cloud host already; null for any other. Such a server answers no local call. */
  cloudMachine(dataDir: string): CloudMachineRecord | null
  pairLines(): Promise<string[]>
  /** Runs the provider's own sign-in in this terminal; answers whether it finished. */
  setUpProvider(provider: Provider): Promise<boolean>
}

type Path = 'pair' | 'account' | 'organization' | 'later'

/**
 * An address makes a cloud host, and only a code or the person's choice names the
 * organization. Without a terminal there is no choice, so the address needs a code.
 * `solus setup` asks this before it installs the service.
 */
export function assertAddressHasOrganization(options: Pick<OnboardingOptions, 'address' | 'link'>, hasTerminal: boolean): void {
  if (options.address && !options.link && !hasTerminal) {
    throw new Error('`--address` makes this server a cloud host of an organization, and without a terminal a link code names the organization. Run `solus setup --link CODE --address URL` with a code from Solus: Organization settings → Add your own VM.')
  }
}

export async function onboard(options: OnboardingOptions, deps: OnboardingDeps): Promise<void> {
  const { prompter } = deps
  assertAddressHasOrganization(options, prompter !== null)
  const cloudMachine = deps.cloudMachine(options.dataDir)
  if (cloudMachine) return reportCloudHostUnchanged(options, deps, cloudMachine)
  if (options.link) return connectWithCode(options, deps, options.link)
  if (!prompter) return printHowToConnect(options, deps)
  return askAndConnect(options, deps, prompter)
}

/** A server that is a cloud host already: nothing here links, pairs, or changes it. */
async function reportCloudHostUnchanged(options: OnboardingOptions, deps: OnboardingDeps, cloudMachine: CloudMachineRecord): Promise<void> {
  const { log } = deps
  for (const line of describeCloudMachine(cloudMachine)) log(line)
  if (options.link || options.address) {
    log('')
    log(`Nothing was changed: this server is a cloud host already${options.link ? ', and the link code was not used' : ''}. To set up another machine, use a new data directory (\`--data-dir PATH\`).`)
  }
  if (deps.prompter && options.mode === 'setup') await offerProviders(deps)
}

async function connectWithCode(options: OnboardingOptions, deps: OnboardingDeps, code: string): Promise<void> {
  const connected = await deps.connect({ dataDir: options.dataDir, cloudUrl: options.cloudUrl, noOpen: true, code, address: options.address }, reporter(deps, 'organization'))
  deps.log('')
  for (const line of await connectionLines(options, deps, connected)) deps.log(line)
  if (deps.prompter && options.mode === 'setup') await offerProviders(deps)
}

/** No code and no terminal: nothing is asked, and nothing waits. */
async function printHowToConnect(options: OnboardingOptions, deps: OnboardingDeps): Promise<void> {
  const { log } = deps
  if (options.mode === 'connect') throw new Error('Linking without a terminal needs a link code: run `solus connect --code CODE` with a code from Solus (Settings → Link a machine). For a cloud host of an organization, run `solus connect --code CODE --address URL` with a code from Organization settings → Add your own VM.')
  for (const line of await deps.pairLines()) log(line)
  log('')
  log('To link this server to your Solus account, run `solus setup --link CODE` with a code from Solus: Settings → Link a machine.')
  log('To make it a cloud host of an organization, run `solus setup --link CODE --address URL` with a code from Organization settings → Add your own VM. URL is the HTTPS address of this machine.')
}

async function askAndConnect(options: OnboardingOptions, deps: OnboardingDeps, prompter: Prompter): Promise<void> {
  const { log } = deps
  const current = await deps.status(options.dataDir)
  // An address names the use by itself: a cloud host of an organization.
  const path = options.address ? 'organization' : await askPath(options, deps, prompter, current.uplink)
  let connected: UplinkStatus | null = null
  if (path === 'pair') {
    for (const line of await deps.pairLines()) log(line)
  } else if (path === 'account' || path === 'organization') {
    connected = await deps.connect({ dataDir: options.dataDir, cloudUrl: options.cloudUrl, noOpen: options.noOpen === true, address: options.address }, reporter(deps, path))
  }
  log('')
  for (const line of await connectionLines(options, deps, connected)) log(line)
  if (options.mode === 'setup') await offerProviders(deps)
}

/** Asks how the server will be used. No address was given, so an organization answer stops here, before the sign-in. */
async function askPath(options: OnboardingOptions, deps: OnboardingDeps, prompter: Prompter, uplink: UplinkStatus): Promise<Exclude<Path, 'organization'>> {
  const isRegistered = uplink.registration.registered
  if (isRegistered && !options.isDesktopApp) deps.log('This server is registered to a Solus account, so it cannot become a cloud host of an organization. A cloud host starts with new data: use a new data directory (`--data-dir PATH`).')
  const choices = pathChoices(uplink)
    .filter((choice) => options.mode === 'setup' || choice.value !== 'pair')
    .filter((choice) => !options.isDesktopApp || choice.value !== 'organization')
  const path = await prompter.choose<Path>('How will you use this server?', choices, isRegistered || options.mode === 'connect' ? choices[0]!.value : 'pair')
  if (path === 'organization') throw new Error(ADDRESS_NEEDED)
  return path
}

function pathChoices({ registration, link }: UplinkStatus) {
  return [
    { value: 'pair' as const, label: 'Connect a client directly', hint: 'Pair a Solus app with this server. No Solus account needed.' },
    ...(registration.registered && link.linked ? [] : [{ value: 'account' as const, label: 'Connect to your Solus account', hint: 'Registers this server and makes it reachable from the internet, so your Solus apps find it. Work here stays on this server.' }]),
    ...(registration.registered ? [] : [{ value: 'organization' as const, label: 'Make this a cloud host of an organization', hint: 'The server works for one organization, and its members reach it through Solus at its own HTTPS address (`--address URL`). It starts with new data and has no pairing code.' }]),
    { value: 'later' as const, label: registration.registered ? 'Keep the current connection' : 'Skip for now', hint: 'Run `solus connect` later.' },
  ]
}

/**
 * What to print after a connect. A server that became a cloud host answers no local
 * call from now on, so its lines come from the answer of the call that made it. Any
 * other server reads its live status.
 */
async function connectionLines(options: OnboardingOptions, deps: OnboardingDeps, connected: UplinkStatus | null): Promise<string[]> {
  const registration = connected?.registration.registered ? connected.registration.registration : null
  const organizationId = registration?.organizationId
  if (!connected || !registration || !organizationId) return describeConnection(await deps.status(options.dataDir))
  const { link } = connected
  return [
    'This server is now a cloud host. It works for one organization, and members of that organization reach it through Solus.',
    '',
    ...describeCloudMachine({ registration: { ...registration, organizationId }, tunnel: link.linked ? link.tunnel : null }, link.linked ? undefined : link.error),
  ]
}

function reporter(deps: OnboardingDeps, path: 'account' | 'organization'): ConnectReporter {
  return {
    stage: (message) => deps.log(`✓ ${message}`),
    deviceCode: (grant: DeviceCodeGrant) => {
      deps.log('')
      deps.log('On any device, open this page and approve the server:')
      deps.log(`  ${grant.verificationUrl}`)
      deps.log(`Code: ${formatUserCode(grant.userCode)}`)
      deps.log('')
      deps.log('Waiting for approval...')
    },
    choose: async (organizations: AccountOrganization[]): Promise<ConnectChoice> => {
      if (path === 'account') return { kind: 'personal' }
      if (organizations.length === 0) throw new Error('Your Solus account is not in an organization. Create or join one in Solus, then run `solus connect` again.')
      if (organizations.length === 1 || !deps.prompter) {
        const [only] = organizations
        deps.log(`Organization: ${only!.name}.`)
        return { kind: 'organization', organizationId: only!.organizationId }
      }
      const organizationId = await deps.prompter.choose('Which organization?', organizations.map((organization) => ({
        value: organization.organizationId,
        label: organization.name,
        hint: organization.hostRules.allowsCloudHosts ? undefined : 'Does not allow cloud hosts',
      })), organizations[0]!.organizationId)
      return { kind: 'organization', organizationId }
    },
  }
}

/** Offers each provider's own sign-in once; skipping is always an answer. Never runs without a terminal. */
async function offerProviders(deps: OnboardingDeps): Promise<void> {
  const prompter = deps.prompter
  if (!prompter) return
  const done = new Set<Provider>()
  for (;;) {
    const remaining = (['claude-code', 'codex'] as const).filter((provider) => !done.has(provider))
    if (remaining.length === 0) return
    const picked = await prompter.choose<Provider | 'skip'>('Set up an agent provider on this server?', [
      ...remaining.map((provider) => ({ value: provider, label: provider === 'claude-code' ? 'Claude Code (claude auth login)' : 'Codex (codex login --device-auth)' })),
      { value: 'skip' as const, label: 'Skip for now', hint: 'Sign in later with the same commands.' },
    ], 'skip')
    if (picked === 'skip') return
    done.add(picked)
    deps.log((await deps.setUpProvider(picked)) ? `✓ ${picked === 'claude-code' ? 'Claude Code' : 'Codex'} signed in` : `${picked === 'claude-code' ? 'Claude Code' : 'Codex'} was not signed in. Run its sign-in command again later.`)
  }
}

/**
 * The connection of a personal server, for setup and `solus connect status`: its kind,
 * the control plane and the Solus API it names, how it is reached, and what waits for
 * delivery. Never a credential.
 */
export function describeConnection({ uplink, standing }: { uplink: UplinkStatus; standing: HostOrganizationsStatus }): string[] {
  const { registration, link } = uplink
  if (!registration.registered) {
    return ['Solus: not registered. Clients connect to this server directly; its work stays here.']
  }
  const tunnel = !link.linked
    ? 'local network only (not linked)'
    : `${link.tunnel.hostname} — ${link.state.observed === 'error' && link.state.error ? `error — ${link.state.error}` : link.state.observed}`
  const owner = registration.owner?.email ?? registration.owner?.name
  const lines = [
    `Solus: registered${owner ? ` to ${owner}` : ''}`,
    `  Server: ${registration.registration.hostId} (${kindLabel(standing.kind)})`,
    `  Control plane: ${registration.registration.directoryUrl}`,
  ]
  if (standing.apiUrl) lines.push(`  Solus API: ${standing.apiUrl}`)
  lines.push(`  Reachable from the internet: ${tunnel}`)
  const waiting = standing.delivery.filter((entry) => entry.pending > 0 || entry.failed > 0)
  for (const entry of waiting) {
    const name = standing.organizations.find((organization) => organization.organizationId === entry.organizationId)?.name ?? entry.organizationId
    lines.push(`  Waiting for ${name}: ${entry.pending} queued${entry.failed ? `, ${entry.failed} refused` : ''}`)
  }
  if (standing.deliveryError) lines.push(`  Last delivery error: ${standing.deliveryError}`)
  return lines
}

/**
 * A cloud host, for setup and `solus connect status`: its organization, the control
 * plane and the Solus API it names, and the address members reach it at. These come
 * from its records, not from the running server: a cloud host trusts no local
 * connection, so it has no live status for the command line. `linkError` is why Solus
 * cloud did not record the address, when the call that made the cloud host said so.
 */
export function describeCloudMachine({ registration, tunnel }: CloudMachineRecord, linkError?: string): string[] {
  const address = tunnel
    ? `https://${tunnel.hostname}${registration.hasManagedCompute ? '' : ` (it must forward to port ${tunnel.proxiedPort} on this machine)`}`
    : `Solus cloud did not record it yet${linkError ? ` (${linkError})` : ''}. Restart the server so that it asks again.`
  return [
    `Solus: cloud host of organization ${registration.organizationId}`,
    `  Server: ${registration.hostId} (${kindLabel('cloud')})`,
    `  Control plane: ${registration.directoryUrl}`,
    ...(registration.apiUrl ? [`  Solus API: ${registration.apiUrl}`] : []),
    `  Address: ${address}`,
    '  Members of the organization reach this server through Solus. It has no pairing code.',
    '  Live status is not available from the command line: a cloud host trusts no local connection. See the machine in the Solus console.',
  ]
}

/** The server's test of its own connection, for `solus connect status`. */
export function describeSelfTest({ selfTest, selfTestError }: ConnectSelfTest): string[] {
  if (!selfTest) return [`Connection test: could not run (${selfTestError}). Run \`solus update\` if this server is older than this command.`]
  const { problem } = selfTest
  return [
    `Connection test: ${selfTest.summary}`,
    ...selfTest.stages.map((report) => `  ${connectionStageLine(report)}`),
    ...selfTest.facts.map((fact) => `  ${fact.label}: ${fact.value}`),
    ...(problem?.hint ? [`  ${problem.hint}`] : []),
    ...(problem ? [`  Fix: ${problem.fix}`] : []),
  ]
}

function kindLabel(kind: MachineKind): string {
  return kind === 'cloud' ? 'Cloud host' : 'Personal computer'
}

export function formatUserCode(value: string): string {
  const compact = value.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  return compact.length === 8 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : value
}
