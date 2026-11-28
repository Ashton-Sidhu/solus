import { isWaitingForHost, type HostReadiness } from '@solus/client-core/host-readiness'
import { awaitsManagedCompute, hostInOrganization, type KnownHostUplink } from '@solus/client-core/known-host'
import {
  MANAGED_HOST_PACKAGE_PATTERN,
  MAX_MANAGED_HOST_PACKAGES,
  MAX_MANAGED_HOST_SETUP_SCRIPT_LENGTH,
  type ManagedHostCatalog,
  type ManagedHostSize,
  type ManagedHostSpecRequest,
  type HostRules,
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
  readiness: HostReadiness
  uplink?: KnownHostUplink
}

export interface ComputeChoices<T extends ComputeHost> {
  /** The active organization's cloud host; every member sees it. */
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
    server.uplink?.kind === 'cloud' && hostInOrganization(server.uplink, account.activeOrganizationId)) ?? null
  const personal = servers.filter((server) => server.uplink?.kind !== 'cloud')
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
  const online = (server: T) => server.readiness === 'ready'
  const { cloudHost } = choices
  if (cloudHost && (online(cloudHost) || awaitsManagedCompute(cloudHost.uplink))) return cloudHost
  return choices.ownMachines.find(online) ?? choices.sharedMachines.find(online) ?? cloudHost
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
  if (server.readiness === 'ready') return 'Ready'
  return isWaitingForHost(server.readiness) ? 'Connecting…' : 'Can’t reach it'
}

/**
 * Where the work of cloud step 1 is after the person moved on (docs/plans/
 * one-page-onboarding.md decision 1): a cloud host that is made or started,
 * or a computer that links. A host that failed is `failed`, never a spinner
 * with no end: the step must say that nothing runs.
 */
export function machineStepProgress(input: {
  host: ComputeHost | null
  isBusy: boolean
  hasError: boolean
  isLinking: boolean
}): 'working' | 'failed' | 'settled' {
  if (input.host?.readiness === 'ready') return 'settled'
  if (input.hasError || input.host?.uplink?.managedState === 'failed') return 'failed'
  if (input.isBusy || input.isLinking || input.host) return 'working'
  return 'settled'
}

/**
 * What the machine step says when Solus Cloud did not create the cloud host. The
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

/**
 * The name a new cloud host is given: its organization's, so it reads "Cloud · Acme"
 * everywhere, not the generic "Cloud host". Members can rename it on Solus Cloud.
 */
export function newCloudHostLabel(organization: { name: string } | null): string {
  return organization?.name.trim() || CLOUD_HOST_LABEL
}

/** What the machine step needs of the active organization. */
export interface MachineOrganization {
  mayCreateManagedHost: boolean
  /** The organization's host rules (organization-scope §3.1); an older Solus Cloud sends none, which allows both. */
  hostRules?: Pick<HostRules, 'allowsCloudHosts' | 'allowsPersonalHosts'>
}

/** The choices of "Where your agents run" an organization offers. */
export interface MachineTargets {
  cloud: boolean
  own: boolean
}

/**
 * Which choices of "Where your agents run" the organization offers: its cloud
 * host (one there, or one this member may create and Solus Cloud can make),
 * and a computer of the person's own. The organization's owners may turn
 * either off; an older Solus Cloud says nothing, which allows both.
 */
export function machineTargets<T extends ComputeHost>(
  choices: ComputeChoices<T>,
  organization: MachineOrganization | null,
  catalog: ManagedHostCatalog | undefined,
): MachineTargets {
  const allowsCloud = organization?.hostRules?.allowsCloudHosts !== false
  const allowsOwn = organization?.hostRules?.allowsPersonalHosts !== false
  const canMake = !!organization?.mayCreateManagedHost && (catalog?.sizes.length ?? 0) > 0
  return { cloud: allowsCloud && (!!choices.cloudHost || canMake), own: allowsOwn }
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
