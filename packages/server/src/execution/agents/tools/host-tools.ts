import { z } from 'zod'
import { managedHostSpecChangeResponseSchema, type DirectoryHost, type DirectoryResponse } from '@solus/contracts/uplink'
import type { ListedRemoteHost } from '../../orchestration/remote-hosts'
import {
  NOT_THIS_HOST,
  SIGN_IN,
  answered,
  changeOnCard,
  chosenOrganization,
  cloudPerson,
  type CloudPerson,
  cloudRequest,
  failed,
  hostField,
  hostPath,
  isCloudPersonOffered,
  isThisHost,
  machineFacts,
  namesThisHost,
  organizationNames,
  organizationsOf,
  packagesField,
  personAndHost,
  personalPerson,
  readDirectory,
  reasonField,
  setupScriptField,
  specChange,
  specProblem,
  thisHostId,
} from './cloud-machine-tools'
import { asPerson } from './person-rpc'
import { connectRemoteHost, listedRemoteHosts } from './session-tools'
import type { AgentTool, AgentToolContext, AgentToolResult } from './agent-tool'

/**
 * The host tools that apply to every host (plans/036-host-tools.md §3): one list of
 * the person's hosts, with the actions that apply to each; a Solus update or a setup
 * change; a health check; and sharing a personal host with an organization. A tool
 * refuses a host where its action does not apply, before any request.
 */

type HostKind = DirectoryHost['kind'] | 'unknown'

/** The actions that apply to a host, as the agent names them. */
function actionsFor(row: { kind: HostKind; hasManagedCompute: boolean; source: ListedRemoteHost['source'] | null; isThisHost: boolean }, isSignedIn: boolean): string[] {
  const actions = ['check_host']
  if (!row.isThisHost) actions.push('update_host release')
  if (row.source && row.source !== 'account') actions.push('remove_host')
  if (!isSignedIn) return actions
  if (row.kind === 'cloud' && row.hasManagedCompute && !row.isThisHost) actions.push('start_host', 'stop_host', 'restart_host', 'update_host packages setup_script')
  if (row.kind === 'cloud' && !row.isThisHost) actions.push('delete_host')
  if (row.kind === 'personal') actions.push('share_host', 'unshare_host')
  return actions
}

export const listHostsAgentTool: AgentTool<Record<string, never>> = {
  name: 'list_hosts',
  description: 'List every host you reach: your own computers and the cloud machines of your organizations, with id, name, kind, organizations, state, connection status, and the actions that apply to each (not-paired: use add_host). Also this host, your organizations, and the sizes of a new cloud machine. Use an id or name as host in the other host tools, list_agent_targets, or start_sessions. No credentials are returned.',
  inputFields: {},
  requiresApproval: false,
  async execute(_input, context) {
    const sessionId = context.sessionId()
    const reached = sessionId ? await listedRemoteHosts(sessionId) : null
    if (!reached) return failed('Only a session with host access can list its hosts.')
    // Signed out, the list has the hosts this host reaches and no cloud facts.
    const person = await cloudPerson(context)
    const read = person ? await readDirectory(person) : null
    const directory = read?.ok ? read.value : null
    const isSignedIn = directory !== null
    const inDirectory = (row: ListedRemoteHost) => directory?.hosts.find((host) => host.hostId === row.id || host.installationId === row.installationId)
    const hosts = reached.map((row) => {
      const listed = inDirectory(row)
      const kind: HostKind = listed?.kind ?? 'unknown'
      const facts = { kind, hasManagedCompute: listed?.hasManagedCompute === true, source: row.source, isThisHost: false }
      return {
        id: row.id,
        installationId: row.installationId,
        name: row.name,
        kind: facts.kind,
        organizationIds: listed?.organizationIds ?? [],
        madeBySolus: facts.hasManagedCompute,
        state: row.managedState ?? listed?.managedState ?? null,
        status: row.status,
        actions: actionsFor(facts, isSignedIn),
      }
    })
    // A cloud machine this host does not reach for start_sessions is still the person's to manage.
    for (const host of directory?.hosts ?? []) {
      if (host.kind !== 'cloud' || isThisHost(host) || hosts.some((row) => row.id === host.hostId || row.installationId === host.installationId)) continue
      const facts = machineFacts(host)
      hosts.push({ ...facts, kind: host.kind, status: 'unreachable', actions: actionsFor({ kind: host.kind, hasManagedCompute: facts.madeBySolus, source: null, isThisHost: false }, true) })
    }
    const self = thisHostId()
    const catalog = directory?.managedHostCatalog
    return answered({
      thisHost: { id: self, actions: ['check_host', ...(isSignedIn ? ['share_host', 'unshare_host'] : [])], note: 'This host never stops, restarts, updates, or deletes itself.' },
      hosts,
      ...(directory ? {
        organizations: organizationsOf(directory),
        sizes: catalog?.sizes.map(({ id, label, detail }) => ({ id, label, detail, isDefault: id === catalog.defaultSize })) ?? [],
      } : { note: 'Sign in to Solus to see cloud machines and their actions.' }),
    })
  },
}

const NO_STORED_SETUP = 'This host has no stored setup. Install packages on it yourself, or start a session there.'

const updateFields = {
  host: hostField,
  release: z.boolean().optional().describe('true: install the newest Solus release. Any host.'),
  packages: packagesField.describe('The full list of apt packages; [] clears it. Only a cloud machine that Solus runs.'),
  setup_script: setupScriptField.describe('The full setup script; "" clears it. Only a cloud machine that Solus runs.'),
  reason: reasonField,
}

/** The newest Solus release on another host, through its own gate. */
async function updateRelease(named: string, context: AgentToolContext): Promise<AgentToolResult> {
  const remote = await connectRemoteHost(named, context.sessionId())
  if ('error' in remote) return failed(remote.error)
  const status = await remote.call('the update check', () => remote.api.hostCheckForUpdates())
  if (status.serverUpdate && !status.serverUpdate.supported) return failed(`Solus on ${remote.label} cannot update itself${status.serverUpdate.reason ? `: ${status.serverUpdate.reason}` : ''}.${status.remediation ? ` ${status.remediation}` : ''}`)
  const { check } = status
  if (check.kind === 'up-to-date') return answered({ updated: false, host: remote.label, version: status.currentVersion, note: 'Solus on this host is up to date.' })
  if (check.kind === 'error') return failed(`${remote.label} could not check for an update: ${check.message}`)
  if (check.kind !== 'available') return failed(`${remote.label} cannot check for an update now${check.kind === 'idle' && check.reason ? `: ${check.reason}` : ''}. Try again in a minute.`)
  await remote.call('the update', () => remote.api.hostInstallUpdate())
  return answered({ updating: true, host: remote.label, from: status.currentVersion, to: check.latestVersion, note: 'The host restarts to take the update. It answers again in a minute or two.' })
}

const NAME_A_CHANGE = 'Name what to change: release: true installs the newest Solus release. packages and setup_script apply only to a cloud machine that Solus runs.'

/** Whether this host reaches a host of that name: a computer, which has no stored setup. */
async function isReachedHost(named: string, context: AgentToolContext): Promise<boolean> {
  const name = named.trim()
  const reached = await listedRemoteHosts(context.sessionId() ?? '') ?? []
  return reached.some((row) => row.id === name || row.installationId === name || row.name.toLowerCase() === name.toLowerCase())
}

/** A change of the stored setup of a cloud machine that Solus runs: the given one, or the person's choice on the edit card. */
async function updateSetup(input: z.output<z.ZodObject<typeof updateFields>>, context: AgentToolContext, found: { person: CloudPerson; host: DirectoryHost; directory: DirectoryResponse }): Promise<AgentToolResult> {
  const { person, host, directory } = found
  const problem = specProblem(input.packages, undefined)
  if (problem) return failed(problem)
  let change = specChange(input.packages, input.setup_script)
  if (!change) {
    const onCard = await changeOnCard(context, person, host, directory, input.reason.trim())
    if ('ok' in onCard) return onCard
    change = specChange(onCard.packages, onCard.setupScript)
    if (!change) return answered({ changed: false, note: 'The person chose nothing to change.' })
  }
  const result = await cloudRequest(person, hostPath(host.hostId, 'spec'), managedHostSpecChangeResponseSchema, { method: 'PATCH', body: change })
  if (!result.ok) return failed(result.text)
  if (!result.value.changed) return answered({ changed: false, note: 'The machine has these already. Nothing changed.' })
  const running = host.managedState === 'ready' || host.managedState === 'starting'
  return answered({ changed: true, machine: machineFacts(host), note: running ? 'The machine restarts to take the change.' : 'The machine takes the change when it next starts.' })
}

export const updateHostAgentTool: AgentTool<typeof updateFields> = {
  name: 'update_host',
  description: 'Update a host. release: true installs the newest Solus release, on any host. packages and setup_script change the stored setup of a cloud machine that Solus runs; with none of them on such a machine, a card shows the current setup so the person can edit it. Each change restarts the host. Never this host.',
  inputFields: updateFields,
  requiresApproval: false,
  async execute(input, context) {
    if (namesThisHost(input.host)) return failed(NOT_THIS_HOST)
    const changesSetup = input.packages !== undefined || input.setup_script !== undefined
    if (input.release && changesSetup) return failed('Give release, or packages and setup_script, in one call: each change restarts the host.')
    if (input.release) return updateRelease(input.host, context)
    // A setup change, or no change named: both need the machine in the person's directory.
    const person = await cloudPerson(context)
    if (!person) return failed(changesSetup ? SIGN_IN : NAME_A_CHANGE)
    const found = await personAndHost(context, input.host, { mayBeThisHost: false })
    if ('ok' in found) {
      if (found.text === NOT_THIS_HOST) return found
      if (!changesSetup) return failed(NAME_A_CHANGE)
      // A computer that this host reaches is not in the directory of cloud machines, and it has no stored setup.
      return await isReachedHost(input.host, context) ? failed(NO_STORED_SETUP) : found
    }
    if (found.host.kind !== 'cloud' || !found.host.hasManagedCompute) return failed(changesSetup ? NO_STORED_SETUP : NAME_A_CHANGE)
    return updateSetup(input, context, found)
  },
}

const checkFields = {
  host: z.string().max(200).optional().describe('The host: its id, installation id, or exact name from list_hosts. This host when absent.'),
}

export const checkHostAgentTool: AgentTool<typeof checkFields> = {
  name: 'check_host',
  description: 'Check the health of a host: its self test (can people and other hosts reach it) and its CPU and memory now. This host when host is absent.',
  inputFields: checkFields,
  requiresApproval: false,
  async execute(input, context) {
    const named = input.host?.trim()
    if (!named || namesThisHost(named)) {
      return asPerson('check_host', context, async (call) => {
        const [selfTest, resources] = await Promise.all([call('hostSelfTest'), call('hostResources')])
        return answered({ host: 'this host', selfTest, resources })
      })
    }
    const remote = await connectRemoteHost(named, context.sessionId())
    if ('error' in remote) return failed(remote.error)
    const [selfTest, resources] = await Promise.all([
      remote.call('the self test', () => remote.api.hostSelfTest()),
      remote.call('the resources', () => remote.api.hostResources()),
    ])
    return answered({ host: remote.label, selfTest, resources })
  },
}

const shareFields = {
  host: z.string().max(200).optional().describe('The personal host: its id or exact name from list_hosts. This host when absent.'),
  organization: z.string().max(200).optional().describe('An organization id or name; the only one when absent.'),
}

/** The personal host and the organization of a share; the sentence that says why not. */
async function shareTarget(input: z.output<z.ZodObject<typeof shareFields>>, context: AgentToolContext): Promise<{ userId: string; hostId: string; hostName: string; organizationId: string; organizationName: string; person: NonNullable<Awaited<ReturnType<typeof personalPerson>>> } | AgentToolResult> {
  const person = await personalPerson(context)
  if (!person) return failed('Only the owner of a personal host, signed in to Solus on this host, can share it.')
  const read = await readDirectory(person)
  if (!read.ok) return failed(read.text)
  const organizations = organizationsOf(read.value)
  const chosen = chosenOrganization(person, organizations, input.organization)
  if ('problem' in chosen) return failed(chosen.problem)
  if (!chosen.organization) return failed(`Name the organization. Your organizations: ${organizationNames(organizations)}.`)
  const named = input.host?.trim()
  let hostId: string | null
  let hostName: string
  // The directory that a host reads leaves itself out, so this host is found by its own id.
  if (!named || namesThisHost(named)) {
    hostId = thisHostId()
    hostName = 'this host'
    if (!hostId) return failed('This host is not linked to Solus Cloud, so it cannot be shared with an organization.')
  } else {
    const found = await personAndHost(context, named, { kind: 'personal', mayBeThisHost: true })
    if ('ok' in found) return found
    hostId = found.host.hostId
    hostName = found.host.label
  }
  return { userId: person.userId, hostId, hostName, organizationId: chosen.organization.id, organizationName: chosen.organization.name, person }
}

export const shareHostAgentTool: AgentTool<typeof shareFields> = {
  name: 'share_host',
  description: 'Share your personal host with an organization, so its members run agent work on it. This host when host is absent. Only when the person asks. unshare_host takes it back.',
  inputFields: shareFields,
  // Members can run agents on the machine once it is shared (plans/036 §3).
  requiresApproval: true,
  isOffered: isCloudPersonOffered,
  async execute(input, context) {
    const target = await shareTarget(input, context)
    if ('ok' in target) return target
    const result = await cloudRequest(target.person, hostPath(target.hostId, 'organizations'), z.null(), { method: 'POST', body: { organizationId: target.organizationId } })
    if (!result.ok) return failed(result.text)
    return answered({ shared: true, host: target.hostName, organization: target.organizationName, note: 'Members of the organization can now run work on this host.' })
  },
}

export const unshareHostAgentTool: AgentTool<typeof shareFields> = {
  name: 'unshare_host',
  description: 'Take your personal host back from an organization: its members can no longer start work on it. This host when host is absent.',
  inputFields: shareFields,
  requiresApproval: false,
  isOffered: isCloudPersonOffered,
  async execute(input, context) {
    const target = await shareTarget(input, context)
    if ('ok' in target) return target
    const result = await cloudRequest(target.person, hostPath(target.hostId, `organizations/${encodeURIComponent(target.organizationId)}`), z.null(), { method: 'DELETE' })
    if (!result.ok) return failed(result.text)
    return answered({ shared: false, host: target.hostName, organization: target.organizationName })
  },
}

