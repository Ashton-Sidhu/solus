import type { DeviceCodeGrant } from '@solus/client-core/device-authorization'
import { isOrganizationTicket, parseLinkCode, type AccountOrganization, type MachineKind, type UplinkStatus } from '@solus/contracts/uplink'
import { connectionStageLine } from '@solus/contracts/host-connection'
import { describeReach, type CloudMachineRecord } from './cloud-machine'
import { DEFAULT_CLOUD_ORIGIN, type ConnectChoice, type ConnectionStatus, type ConnectOptions, type ConnectReporter, type ConnectSelfTest } from './connect'
import type { Prompter } from './prompts'

/**
 * What `solus setup` does after the service is healthy, and what `solus connect`
 * repeats (plans/034-one-cloud-machine-kind.md). A link code decides everything by
 * itself. Without one, a terminal asks: pair a client directly, link to the person's
 * account for discovery and remote access, or make the server a cloud host of an
 * organization. A cloud host works for that one organization and starts with new
 * data, so a server that is registered already is not offered that choice. An address
 * (`--address`) is for both kinds: the internet reaches the server there, and without
 * one the server gets a Cloudflare tunnel. Without a terminal, nothing is asked and
 * nothing waits: the pairing details are printed, with how to link.
 */

export type Provider = 'claude-code' | 'codex'

export interface OnboardingOptions {
  dataDir: string
  cloudUrl?: string
  /** A link code: connects without a question. */
  link?: string
  /** This machine's own HTTPS address: the internet reaches the server there, with no tunnel. */
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
  status(dataDir: string): Promise<ConnectionStatus>
  /** The records of a server that is a cloud host already; null for any other. Such a server answers no local call. */
  cloudMachine(dataDir: string): CloudMachineRecord | null
  pairLines(): Promise<string[]>
  /** Runs the provider's own sign-in in this terminal; answers whether it finished. */
  setUpProvider(provider: Provider): Promise<boolean>
}

type Path = 'pair' | 'account' | 'organization' | 'later'

/** The server of the desktop app is a personal computer always; an organization code would make a cloud host of it. */
const DESKTOP_IS_PERSONAL = 'This is an organization code: it makes a standalone Solus server a cloud host. The server of the desktop app is a personal computer always. Link it with a code from Settings → Link a machine, or run `solus connect` with no code.'

export async function onboard(options: OnboardingOptions, deps: OnboardingDeps): Promise<void> {
  const { prompter } = deps
  const cloudMachine = deps.cloudMachine(options.dataDir)
  if (cloudMachine) return reportCloudHostUnchanged(options, deps, cloudMachine)
  if (options.link) {
    if (options.isDesktopApp && isOrganizationTicket(parseLinkCode(options.link, DEFAULT_CLOUD_ORIGIN).ticket)) throw new Error(DESKTOP_IS_PERSONAL)
    return connectWithNoQuestion(options, deps)
  }
  // With no address and no terminal there is nothing to ask the server.
  if (!options.address && !prompter) return printHowToConnect(options, deps)
  const current = await deps.status(options.dataDir)
  // A registered server with an address: the address is the whole request.
  if (options.address && current.uplink.registration.registered) return connectWithNoQuestion(options, deps)
  if (!prompter) return printHowToConnect(options, deps)
  return askAndConnect(options, deps, prompter, current.uplink)
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

/** A link code, or a new address for a registered server: the request says everything. */
async function connectWithNoQuestion(options: OnboardingOptions, deps: OnboardingDeps): Promise<void> {
  const connected = await deps.connect({ dataDir: options.dataDir, cloudUrl: options.cloudUrl, noOpen: true, code: options.link, address: options.address }, reporter(deps, 'organization'))
  deps.log('')
  for (const line of await connectionLines(options, deps, connected)) deps.log(line)
  if (deps.prompter && options.mode === 'setup') await offerProviders(deps)
}

const ADDRESS_HINT = 'When this machine has its own HTTPS address, add `--address URL`: the internet reaches the server there. Without it the server gets a Cloudflare tunnel.'

/** No code and no terminal: nothing is asked, and nothing waits. */
async function printHowToConnect(options: OnboardingOptions, deps: OnboardingDeps): Promise<void> {
  const { log } = deps
  if (options.mode === 'connect') throw new Error(`Linking without a terminal needs a link code: run \`solus connect --code CODE\` with a code from Solus (Settings → Link a machine). For a cloud host of an organization, use a code from Organization settings → Add your own VM. ${ADDRESS_HINT}`)
  for (const line of await deps.pairLines()) log(line)
  log('')
  if (options.address) log('`--address` was not used: this server is not registered, and without a terminal it registers with a link code.')
  log('To link this server to your Solus account, run `solus setup --link CODE` with a code from Solus: Settings → Link a machine.')
  log('To make it a cloud host of an organization, run `solus setup --link CODE` with a code from Organization settings → Add your own VM.')
  log(ADDRESS_HINT)
}

async function askAndConnect(options: OnboardingOptions, deps: OnboardingDeps, prompter: Prompter, uplink: UplinkStatus): Promise<void> {
  const { log } = deps
  const path = await askPath(options, deps, prompter, uplink)
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

/** Asks how the server will be used. */
async function askPath(options: OnboardingOptions, deps: OnboardingDeps, prompter: Prompter, uplink: UplinkStatus): Promise<Path> {
  const isRegistered = uplink.registration.registered
  if (isRegistered && !options.isDesktopApp) deps.log('This server is registered to a Solus account, so it cannot become a cloud host of an organization. A cloud host starts with new data: use a new data directory (`--data-dir PATH`).')
  const choices = pathChoices(uplink)
    .filter((choice) => options.mode === 'setup' || choice.value !== 'pair')
    .filter((choice) => !options.isDesktopApp || choice.value !== 'organization')
  return prompter.choose<Path>('How will you use this server?', choices, isRegistered || options.mode === 'connect' ? choices[0]!.value : 'pair')
}

function pathChoices({ registration, link }: UplinkStatus) {
  return [
    { value: 'pair' as const, label: 'Connect a client directly', hint: 'Pair a Solus app with this server. No Solus account needed.' },
    ...(registration.registered && link.linked ? [] : [{ value: 'account' as const, label: 'Connect to your Solus account', hint: 'Registers this server and makes it reachable from the internet, so your Solus apps find it. Work here stays on this server.' }]),
    ...(registration.registered ? [] : [{ value: 'organization' as const, label: 'Make this a cloud host of an organization', hint: 'The server works for one organization, and its members reach it through Solus. It starts with new data and has no pairing code.' }]),
    { value: 'later' as const, label: registration.registered ? 'Keep the current connection' : 'Skip for now', hint: 'Run `solus connect` later.' },
  ]
}

/**
 * What to print after a connect. A server that became a cloud host answers no local
 * call from now on, so its lines come from the answer of the call that made it, and
 * its reach from the request: an address when one was given, else a tunnel. Any other
 * server reads its live status.
 */
async function connectionLines(options: OnboardingOptions, deps: OnboardingDeps, connected: UplinkStatus | null): Promise<string[]> {
  const registration = connected?.registration.registered ? connected.registration.registration : null
  const organizationId = registration?.organizationId
  if (!connected || !registration || !organizationId) return describeConnection(await deps.status(options.dataDir))
  const { link } = connected
  return [
    'This server is now a cloud host. It works for one organization, and members of that organization reach it through Solus.',
    '',
    ...describeCloudMachine({ registration: { ...registration, organizationId }, tunnel: link.linked ? link.tunnel : null, reach: options.address ? 'direct' : 'tunnel' }, link.linked ? undefined : link.error),
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
export function describeConnection({ uplink, standing, reach }: ConnectionStatus): string[] {
  const { registration, link } = uplink
  if (!registration.registered) {
    return ['Solus: not registered. Clients connect to this server directly; its work stays here.']
  }
  const reachLine = !link.linked
    ? 'Reachable from the internet: local network only (not linked)'
    : `${describeReach(link.tunnel, reach)} — ${link.state.observed === 'error' && link.state.error ? `error — ${link.state.error}` : link.state.observed}`
  const owner = registration.owner?.email ?? registration.owner?.name
  const lines = [
    `Solus: registered${owner ? ` to ${owner}` : ''}`,
    `  Server: ${registration.registration.hostId} (${kindLabel(standing.kind)})`,
    `  Control plane: ${registration.registration.directoryUrl}`,
  ]
  if (standing.apiUrl) lines.push(`  Solus API: ${standing.apiUrl}`)
  lines.push(`  ${reachLine}`)
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
 * plane and the Solus API it names, and how members reach it: its own address, or the
 * host name of its tunnel. These come from its records, not from the running server:
 * a cloud host trusts no local connection, so it has no live status for the command
 * line. `linkError` is why Solus cloud did not make the link, when the call that made
 * the cloud host said so.
 */
export function describeCloudMachine({ registration, tunnel, reach }: CloudMachineRecord, linkError?: string): string[] {
  const reachLine = tunnel
    ? describeReach(tunnel, reach, registration.hasManagedCompute === true)
    : `Reachable from the internet: not yet${linkError ? ` (${linkError})` : ''}. Restart the server so that it asks Solus cloud again.`
  return [
    `Solus: cloud host of organization ${registration.organizationId}`,
    `  Server: ${registration.hostId} (${kindLabel('cloud')})`,
    `  Control plane: ${registration.directoryUrl}`,
    ...(registration.apiUrl ? [`  Solus API: ${registration.apiUrl}`] : []),
    `  ${reachLine}`,
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
