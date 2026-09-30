import type { DeviceCodeGrant } from '@solus/client-core/device-authorization'
import type { HostOrganizationsStatus } from '@solus/contracts/organization-scope'
import type { AccountOrganization, UplinkStatus } from '@solus/contracts/uplink'
import type { ConnectChoice, ConnectOptions, ConnectReporter } from './connect'
import type { Prompter } from './prompts'

/**
 * What `solus setup` does after the service is healthy, and what `solus connect`
 * repeats (plans/009-organization-vms.md §5). A link code decides everything by
 * itself. Without one, a terminal asks: pair a client directly, link to the
 * person's account for discovery and remote access, or attach the server to an
 * organization — after which new work here starts in that organization, and the
 * personal work already here stays where it is. Without a terminal, nothing is
 * asked and nothing waits: the pairing details are printed, with how to link.
 */

export type Provider = 'claude-code' | 'codex'

export interface OnboardingOptions {
  dataDir: string
  cloudUrl?: string
  /** A link code: links, or attaches an already-linked server, without a question. */
  link?: string
  /** `connect` asks only how to link; `setup` also offers direct pairing and provider sign-in. */
  mode: 'setup' | 'connect'
  /** Do not open a browser for sign-in; the page and code are printed either way. */
  noOpen?: boolean
}

export interface OnboardingDeps {
  /** Null without a terminal: nothing is asked, no provider sign-in starts. */
  prompter: Prompter | null
  log(line: string): void
  connect(options: ConnectOptions, reporter: ConnectReporter): Promise<UplinkStatus>
  status(dataDir: string): Promise<{ link: UplinkStatus; standing: HostOrganizationsStatus }>
  pairLines(): Promise<string[]>
  /** Runs the provider's own sign-in in this terminal; answers whether it finished. */
  setUpProvider(provider: Provider): Promise<boolean>
}

type Path = 'pair' | 'account' | 'organization' | 'later'

export async function onboard(options: OnboardingOptions, deps: OnboardingDeps): Promise<void> {
  const { prompter, log } = deps
  if (options.link) {
    await deps.connect({ dataDir: options.dataDir, cloudUrl: options.cloudUrl, noOpen: true, code: options.link }, reporter(deps, 'organization'))
    log('')
    for (const line of describeConnection(await deps.status(options.dataDir))) log(line)
    if (prompter && options.mode === 'setup') await offerProviders(deps)
    return
  }
  if (!prompter) {
    if (options.mode === 'connect') throw new Error('Linking without a terminal needs a link code: run `solus connect --code CODE` with a code from Solus (Settings → Link a machine, or Organization settings → Add your own VM).')
    for (const line of await deps.pairLines()) log(line)
    log('')
    log('To link this server to Solus, run `solus setup --link CODE` with a code from Solus: Settings → Link a machine, or Organization settings → Add your own VM.')
    return
  }
  const current = await deps.status(options.dataDir)
  const choices = pathChoices(current).filter((choice) => options.mode === 'setup' || choice.value !== 'pair')
  const path = await prompter.choose<Path>('How will you use this server?', choices, current.link.linked || options.mode === 'connect' ? choices[0]!.value : 'pair')
  if (path === 'pair') {
    for (const line of await deps.pairLines()) log(line)
  } else if (path === 'account' || path === 'organization') {
    await deps.connect({ dataDir: options.dataDir, cloudUrl: options.cloudUrl, noOpen: options.noOpen === true }, reporter(deps, path))
  }
  log('')
  for (const line of describeConnection(await deps.status(options.dataDir))) log(line)
  if (options.mode === 'setup') await offerProviders(deps)
}

function pathChoices(current: { link: UplinkStatus; standing: HostOrganizationsStatus }) {
  const attached = current.standing.attachedAt !== null
  return [
    { value: 'pair' as const, label: 'Connect a client directly', hint: 'Pair a Solus app with this server. No Solus account needed.' },
    ...(current.link.linked ? [] : [{ value: 'account' as const, label: 'Link to your Solus account', hint: 'Your Solus apps find this server. Work here stays on this server.' }]),
    {
      value: 'organization' as const,
      label: attached ? 'Attach to another organization' : 'Attach to an organization',
      hint: 'New work on this server belongs to the organization and is saved in its Solus API. Personal work already here stays on this server.',
    },
    { value: 'later' as const, label: current.link.linked ? 'Keep the current connection' : 'Skip for now', hint: 'Run `solus connect` later.' },
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
        deps.log(`Attaching to ${only!.name}.`)
        return { kind: 'organization', organizationId: only!.organizationId }
      }
      const organizationId = await deps.prompter.choose('Which organization?', organizations.map((organization) => ({
        value: organization.organizationId,
        label: organization.name,
        hint: organization.policy.allowsPersonalHosts ? undefined : 'Allows self-hosted servers only',
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
 * The server's connection, for setup and `solus connect status`: its kind, whether
 * it is attached for organization work and to which organizations, how it is
 * reached, and what waits for delivery. Never a credential.
 */
export function describeConnection({ link, standing }: { link: UplinkStatus; standing: HostOrganizationsStatus }): string[] {
  if (!link.linked) {
    return ['Solus: not linked. Clients connect to this server directly; its work stays here.']
  }
  const tunnel = link.state.observed === 'error' && link.state.error ? `error — ${link.state.error}` : link.state.observed
  const attached = standing.organizations.filter((organization) => organization.shared)
  const lines = [
    'Solus: linked',
    `  Server: ${link.link.hostname} (${categoryLabel(standing.category)})`,
    `  Reachable: ${tunnel}`,
  ]
  if (standing.attachedAt !== null) {
    lines.push(`  Organization work: ${attached.length ? attached.map((organization) => organization.name).join(', ') : 'no organization attached — new work cannot start until one is'}`)
    lines.push('  New work here belongs to the organization and is saved in its Solus API; personal work already here stays on this server.')
  } else {
    lines.push('  Organization work: not attached. New work here stays on this server.')
  }
  if (standing.apiUrl) lines.push(`  Solus API: ${standing.apiUrl}`)
  const waiting = standing.delivery.filter((entry) => entry.pending > 0 || entry.failed > 0)
  for (const entry of waiting) {
    const name = standing.organizations.find((organization) => organization.organizationId === entry.organizationId)?.name ?? entry.organizationId
    lines.push(`  Waiting for ${name}: ${entry.pending} queued${entry.failed ? `, ${entry.failed} refused` : ''}`)
  }
  if (standing.deliveryError) lines.push(`  Last delivery error: ${standing.deliveryError}`)
  return lines
}

function categoryLabel(category: HostOrganizationsStatus['category']): string {
  switch (category) {
    case 'personal': return 'personal computer'
    case 'self-hosted': return 'self-hosted server'
    case 'managed': return 'Solus cloud host'
  }
}

export function formatUserCode(value: string): string {
  const compact = value.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  return compact.length === 8 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : value
}
