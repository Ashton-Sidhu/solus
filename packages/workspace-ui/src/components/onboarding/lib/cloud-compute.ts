import { awaitsManagedCompute, hostInOrganization, type SavedServerUplink } from '@solus/client-core/server-registry'
import {
  MANAGED_HOST_PACKAGE_PATTERN,
  MAX_MANAGED_HOST_PACKAGES,
  MAX_MANAGED_HOST_SETUP_SCRIPT_LENGTH,
  type ManagedHostCatalog,
  type ManagedHostSize,
  type ManagedHostSpecRequest,
  type OrganizationPolicy,
} from '@solus/contracts/uplink'
import { CLOUD_HOST_LABEL } from '../../../contexts/connections/host-label'
import { managedHostStateLabel } from '../../servers/lib/managed-host'

/**
 * Where a cloud account's agents can run (docs/plans/cloud-onboarding.md §3.1):
 * the organization's cloud host, the machines this account linked, and machines
 * other members shared with the organization. The workspace service is none of
 * these; callers pass `serversStore.servers`, which never lists it.
 */

export interface ComputeHost {
  id: string
  label: string
  status: string
  uplink?: SavedServerUplink
}

export interface ComputeChoices<T extends ComputeHost> {
  /** The active organization's managed host; every member sees it. */
  cloudHost: T | null
  /** Machines this account linked. Visible to others only when shared. */
  ownMachines: T[]
  /** Machines another member shared with the organization. */
  sharedMachines: T[]
}

export function computeChoices<T extends ComputeHost>(
  servers: readonly T[],
  account: { userId: string; activeOrganizationId: string | null },
): ComputeChoices<T> {
  const cloudHost = servers.find((server) =>
    server.uplink?.kind === 'managed' && hostInOrganization(server.uplink, account.activeOrganizationId)) ?? null
  const personal = servers.filter((server) => server.uplink?.kind !== 'managed')
  // A machine with no owner on record was paired to this browser directly: it is this person's.
  const isOwn = (server: T) => !server.uplink?.ownerUserId || server.uplink.ownerUserId === account.userId
  return {
    cloudHost,
    ownMachines: personal.filter(isOwn),
    sharedMachines: personal.filter((server) => !isOwn(server)),
  }
}

/**
 * The host the flow starts with chosen: the organization's cloud host when this
 * client reaches it, or when it is still coming up (Continue starts it and waits);
 * else a machine this client reaches — the person's own first; else the cloud host
 * anyway, so an invitee still sees it chosen; else none, and the flow continues
 * without a machine. A cloud host Solus Cloud calls ready but this client cannot
 * reach does not win over a machine that answers.
 */
export function defaultComputeHost<T extends ComputeHost>(choices: ComputeChoices<T>): T | null {
  const online = (server: T) => server.status === 'online'
  const { cloudHost } = choices
  if (cloudHost && (online(cloudHost) || awaitsManagedCompute(cloudHost.uplink))) return cloudHost
  return choices.ownMachines.find(online) ?? choices.sharedMachines.find(online) ?? cloudHost
}

/** Whether a machine this account linked is shared with the organization. */
export function isSharedWith(server: ComputeHost, organizationId: string | null): boolean {
  return hostInOrganization(server.uplink, organizationId)
}

/**
 * Whether agents can run there now. A cloud host that is not ready says its state;
 * past that, only this client's own connection answers: Solus Cloud knows the
 * machine runs, not whether this client reaches it. A host not reached yet is
 * still being dialed, not offline.
 */
export function reachability(server: ComputeHost): string {
  const state = managedHostStateLabel(server.uplink)
  if (state) return state
  switch (server.status) {
    case 'online':
      return 'Ready'
    case 'offline':
    case 'different-server':
      return 'Can’t reach it'
    default:
      return 'Connecting…'
  }
}

/** The detail line of the cloud host row: its state, and who can use it. */
export function cloudHostDetail(server: ComputeHost, organizationName: string): string {
  return `${reachability(server)} · Everyone in ${organizationName} can use it`
}

/** The detail line of a machine row: its state, and who can see it. */
export function machineDetail(server: ComputeHost, organization: { organizationId: string; name: string } | null, isOwn: boolean): string {
  if (!isOwn) return `${reachability(server)} · Shared by ${server.uplink?.ownerName ?? 'a member'}`
  const visibility = organization && isSharedWith(server, organization.organizationId)
    ? `Shared with ${organization.name}`
    : 'Only you can see it'
  return `${reachability(server)} · ${visibility}`
}

/**
 * What the compute stage says when Solus Cloud did not create the cloud host. The
 * `/v1` code is kept in the text, so a report names the refusal.
 */
export function createHostFailureMessage(code: string | null, message: string | null): string {
  switch (code) {
    case null:
      return 'Solus Cloud did not answer. Check your connection and try again.'
    case 'managed_hosts_not_configured':
      return 'Cloud hosts are not available for this organization yet.'
    case 'not_a_member':
    case 'organization_not_found':
      return 'You are not a member of this organization. Switch organization and try again.'
    case 'rate_limited':
      return 'Too many tries. Wait a minute and try again.'
    default:
      return `Solus Cloud did not create the host (${message ? `${code}: ${message}` : code}). Try again, or create it on the Hosts page.`
  }
}

// ── "Runs on": the one picker of the compute stage ───────────────────────────

/** A machine already there, a cloud host to create, or a computer to link. */
export type RunsOnValue = `host:${string}` | 'new-cloud' | 'link'

export interface RunsOnOption {
  value: RunsOnValue
  label: string
  /** The picker's group heading. */
  group: string
}

export const runsOnHost = (serverId: string): RunsOnValue => `host:${serverId}`

/** How the picker names a cloud host: "Cloud · Acme". The cloud is where it runs; the rest is its name. */
export function cloudOptionLabel(hostLabel: string): string {
  return `Cloud · ${hostLabel}`
}

/**
 * The name a new cloud host is given: its organization's, so it reads "Cloud · Acme"
 * everywhere, not the generic "Cloud host". Members can rename it on Solus Cloud.
 */
export function newCloudHostLabel(organization: { name: string } | null): string {
  return organization?.name.trim() || CLOUD_HOST_LABEL
}

/** The server a value names, or null for a cloud host to create or a computer to link. */
export function serverIdOf(value: RunsOnValue): string | null {
  return value.startsWith('host:') ? value.slice('host:'.length) : null
}

/** What the picker needs of the active organization. */
export interface RunsOnOrganization {
  name: string
  mayCreateManagedHost: boolean
  /** The organization's host policy (organization-scope §3.1); an older Solus Cloud sends none, which allows both. */
  policy?: Pick<OrganizationPolicy, 'allowsCloudHosts' | 'allowsPersonalHosts'>
}

/**
 * Everything the account can run agents on, grouped as the picker shows it: the
 * organization's cloud host (or one to create, when the person may and Solus Cloud
 * can make one), the person's computers, the ones others shared, and a computer
 * to link — less whatever the organization's host policy turns off. Unless the policy
 * keeps the organization to its cloud host, "Link a computer" is always there.
 */
export function runsOnOptions<T extends ComputeHost>(
  choices: ComputeChoices<T>,
  organization: RunsOnOrganization | null,
  catalog: ManagedHostCatalog | undefined,
): RunsOnOption[] {
  const cloud = 'Solus Cloud'
  const options: RunsOnOption[] = []
  // The organization's owners may keep it to one of the two; an older Solus Cloud says nothing, which allows both.
  const allowsCloud = organization?.policy?.allowsCloudHosts !== false
  const allowsOwn = organization?.policy?.allowsPersonalHosts !== false
  if (!allowsCloud) {
    // Nothing from Solus Cloud is offered.
  } else if (choices.cloudHost) {
    options.push({ value: runsOnHost(choices.cloudHost.id), label: cloudOptionLabel(choices.cloudHost.label), group: cloud })
  } else if (organization?.mayCreateManagedHost && (catalog?.sizes.length ?? 0) > 0) {
    options.push({ value: 'new-cloud', label: `${cloudOptionLabel(newCloudHostLabel(organization))} (new)`, group: cloud })
  }
  if (!allowsOwn) return options
  for (const machine of choices.ownMachines) {
    options.push({ value: runsOnHost(machine.id), label: machine.label, group: 'Your computers' })
  }
  for (const machine of choices.sharedMachines) {
    options.push({
      value: runsOnHost(machine.id),
      label: machine.label,
      group: organization ? `Shared with ${organization.name}` : 'Shared with you',
    })
  }
  options.push({ value: 'link', label: 'Link a computer', group: 'Your computers' })
  return options
}

/**
 * The picker's first value: the machine `defaultComputeHost` would choose (the
 * organization's cloud host first, so an invitee sees it chosen) when the policy
 * offers it, else a new cloud host when one may be made, else the first choice left —
 * or none, when the policy leaves nothing this account can use yet.
 */
export function defaultRunsOn<T extends ComputeHost>(
  choices: ComputeChoices<T>,
  organization: RunsOnOrganization | null,
  catalog: ManagedHostCatalog | undefined,
): RunsOnValue | null {
  const options = runsOnOptions(choices, organization, catalog)
  const offered = (value: RunsOnValue) => options.some((option) => option.value === value)
  const host = defaultComputeHost(choices)
  if (host && offered(runsOnHost(host.id))) return runsOnHost(host.id)
  if (offered('new-cloud')) return 'new-cloud'
  return options[0]?.value ?? null
}

/** What a size means, for the picker: "8 CPU · 32 GB", or its own words when the machine grows on its own. */
export function sizeSummary(size: ManagedHostSize): string {
  return size.cpus && size.memoryGb ? `${size.cpus} CPU · ${size.memoryGb} GB` : size.detail
}

/** The catalog's default size, else its first; null when Solus Cloud cannot make a host. */
export function defaultSize(catalog: ManagedHostCatalog | undefined): ManagedHostSize | null {
  if (!catalog) return null
  return catalog.sizes.find((size) => size.id === catalog.defaultSize) ?? catalog.sizes[0] ?? null
}

/** What the person typed for a new cloud host; empty fields are Solus Cloud's defaults. */
export interface NewCloudHostForm {
  name: string
  size: ManagedHostSize | null
  /** apt package names, separated by spaces, commas, or lines. */
  packages: string
  setupScript: string
}

export type NewCloudHostRequest =
  | { ok: true; label: string; spec: ManagedHostSpecRequest }
  | { ok: false; error: string }

/**
 * The create request the form asks for, or why Solus Cloud would refuse it. An empty
 * name is the organization's; packages and a setup script are sent only when the
 * catalog offers them, so a field Solus Cloud does not support is never asked for.
 */
export function newCloudHostRequest(
  form: NewCloudHostForm,
  organization: { name: string } | null,
  catalog: ManagedHostCatalog | undefined,
): NewCloudHostRequest {
  const spec: ManagedHostSpecRequest = {}
  if (form.size) spec.size = form.size.id
  const packages = [...new Set(form.packages.split(/[\s,]+/).filter(Boolean))]
  if (catalog?.supportsPackages && packages.length > 0) {
    const invalid = packages.filter((name) => !MANAGED_HOST_PACKAGE_PATTERN.test(name))
    if (invalid.length > 0) return { ok: false, error: `Not an apt package name: ${invalid.join(', ')}` }
    if (packages.length > MAX_MANAGED_HOST_PACKAGES) {
      return { ok: false, error: `Up to ${MAX_MANAGED_HOST_PACKAGES} packages. Put the rest in the setup script.` }
    }
    spec.packages = packages
  }
  const setupScript = form.setupScript.trim()
  if (catalog?.supportsSetupScript && setupScript) {
    if (setupScript.length > MAX_MANAGED_HOST_SETUP_SCRIPT_LENGTH) {
      return { ok: false, error: `The setup script is too long. Keep it under ${MAX_MANAGED_HOST_SETUP_SCRIPT_LENGTH / 1024} KB.` }
    }
    spec.setupScript = setupScript
  }
  return { ok: true, label: form.name.trim() || newCloudHostLabel(organization), spec }
}

/** The steps a cloud host goes through before agents can run on it, in order. */
export const HOST_SETUP_STEPS = ['Create', 'Set up', 'Start', 'Connect'] as const

export interface HostSetupStep {
  /** Index into `HOST_SETUP_STEPS`. */
  index: number
  label: string
}

/**
 * Where the chosen cloud host is while the compute stage waits for it. The step
 * follows the lifecycle the directory last reported, not only the request this
 * client sent: a host that is still provisioning says so, and does not say
 * "Connecting" for minutes.
 */
export function hostSetupStep(isCreating: boolean, host: ComputeHost | null): HostSetupStep {
  if (isCreating) return { index: 0, label: 'Creating the cloud host…' }
  switch (host?.uplink?.managedState) {
    case 'provisioning':
      return { index: 1, label: 'Setting up the cloud host…' }
    case 'starting':
    case 'stopping':
    case 'stopped':
    case 'failed':
      return { index: 2, label: 'Starting the cloud host…' }
    default:
      return { index: 3, label: host && host.uplink?.kind !== 'managed' ? `Connecting to ${host.label}…` : 'Connecting to the cloud host…' }
  }
}

/** Elapsed time as `m:ss`. */
export function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
