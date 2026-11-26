import { z } from 'zod'
import {
  cloudMachinePackagesProblem,
  readCloudMachineAnswer,
  type CloudMachineAsk,
  type CloudMachineChoice,
  type CloudMachineOrganization,
} from '@solus/contracts/cloud-machine-card'
import {
  MAX_MANAGED_HOST_SETUP_SCRIPT_LENGTH,
  createManagedHostResponseSchema,
  directoryResponseSchema,
  enrollmentTicketResponseSchema,
  formatLinkCode,
  managedHostRestartResponseSchema,
  managedHostSpecChangeResponseSchema,
  managedHostSpecResponseSchema,
  managedHostStartResponseSchema,
  managedHostStopResponseSchema,
  uplinkErrorBodySchema,
  type CreateManagedHostRequest,
  type DelegationScope,
  type DirectoryHost,
  type DirectoryResponse,
  type ManagedHostCatalog,
  type ManagedHostSpecChangeRequest,
} from '@solus/contracts/uplink'
import { workspaceToolAuthority } from '../../../admission/workspace-tool-authority'
import { LOCAL_ORGANIZATION_ID, isHostOwner } from '../../../admission/principal'
import { organizationOfSession } from '../../../data/sessions/session-records'
import type { AccountReads } from '../../../vault/account-reads'
import { isSshAuthFailure, type SshClient, type SshTarget } from '../../../platform/ssh'
import { resolveSshTarget } from '../../../remote-machines/ssh-targets'
import { checkIdentityFile } from '../../../remote-machines/identity-file'
import { answerToolQuestionWith } from '../../sessions/input-requests'
import type { AgentTool, AgentToolContext, AgentToolResult } from './agent-tool'

/**
 * The cloud machine tools (plans/035-cloud-machine-tools.md §5): an agent lists, makes,
 * changes, starts, stops, restarts, and deletes the cloud machines of the person's
 * organizations. This host sends each request to Solus Cloud with the token it holds
 * for the person of the turn (`AccountReads.fetch`). A turn whose person has no
 * delegation here does not get the tools (§7). A tool never changes, stops, restarts,
 * or deletes this host (decisions 2 and 6).
 */

export interface CloudMachineToolsDeps {
  /** Each request to Solus Cloud goes here, as the person (`AccountReads.fetch`). */
  reads: Pick<AccountReads, 'fetch'>
  /** The people and scopes this host holds a delegation for (`Delegations.holders`). */
  holders: () => Array<{ userId: string; scope: DelegationScope }>
  /** This host: its id at the control plane (null when it is not registered) and its installation id. */
  thisHost: () => { hostId: string | null; installationId: string }
  /** How long create and join wait for the directory to list the new machine, and how often they read. */
  listing?: { timeoutMs: number; pollMs: number }
  /** Runs the join on another machine (`SshClient`, the SSH runner of `hostsAddOverSsh`). */
  ssh: Pick<SshClient, 'run' | 'resolvesToThisMachine'>
  /** The account plane's origin: the host part of a link code. Null when this host is not linked. */
  accountOrigin: () => string | null
}

let deps: CloudMachineToolsDeps | null = null
export function setCloudMachineTools(next: CloudMachineToolsDeps | null): void { deps = next }

/** The rule of `ManagedHostsStore.create`: about 30 s, a read every 2 s. */
const LISTING = { timeoutMs: 30_000, pollMs: 2_000 }

export const SIGN_IN = 'Sign in to Solus to manage cloud machines and organizations.'
export const DECLINED = 'The person declined. Do not ask again unless they ask you to.'

/** The person of the turn, as Solus Cloud knows them, and the delegation this host uses for them. */
export interface CloudPerson {
  userId: string
  scope: DelegationScope
  /** The organization of the turn; null for personal work. */
  organizationId: string | null
}

/**
 * The person of the turn and the delegation to use; null when this host holds none for
 * them. A member works in their organization. The owner works with the delegation of
 * the turn's organization when this host holds one, else with their personal one, which
 * acts in each organization where they have a role (§4).
 */
function personOf(turnOrganizationId: string | null): CloudPerson | null {
  const principal = workspaceToolAuthority()
  if (!principal || !deps) return null
  const held = deps.holders()
  const holds = (userId: string, organizationId: string | null) => held.some((holder) => holder.userId === userId
    && (organizationId === null ? holder.scope === 'personal' : holder.scope !== 'personal' && holder.scope.organizationId === organizationId))
  if (principal.kind === 'org-member') {
    if (!holds(principal.userId, principal.organizationId)) return null
    return { userId: principal.userId, scope: { organizationId: principal.organizationId }, organizationId: principal.organizationId }
  }
  if (principal.kind !== 'owner') return null
  // The owner's account is the one this host holds the personal delegation for (`ownerReach` in boot-server.ts).
  const owner = held.find((holder) => holder.scope === 'personal')
  if (!owner) return null
  const scope: DelegationScope = turnOrganizationId && holds(owner.userId, turnOrganizationId) ? { organizationId: turnOrganizationId } : 'personal'
  return { userId: owner.userId, scope, organizationId: turnOrganizationId }
}

/** The tools are offered when this host holds a delegation for the person of the turn (§7). */
export const isCloudPersonOffered = (): boolean => personOf(null) !== null

/** The person of a call, with the organization of its session. */
export async function cloudPerson(context: AgentToolContext): Promise<CloudPerson | null> {
  const sessionId = context.sessionId()
  const organizationId = sessionId ? await organizationOfSession(sessionId) : LOCAL_ORGANIZATION_ID
  return personOf(organizationId === LOCAL_ORGANIZATION_ID ? null : organizationId)
}

export type CloudAnswer<T> = { ok: true; value: T } | { ok: false; status: number | null; text: string; body?: unknown }

/** The sentence a person can act on for a refusal of Solus Cloud. */
function refusalText(status: number, code: string | null, message: string | null): string {
  switch (code) {
    case 'acting_host_is_target':
      return 'A host cannot change, stop, restart, or delete itself. Do it from another host, or in Settings → Machines.'
    case 'outside_delegation':
      return 'This host acts for you only in another organization. Do it from a session of that organization, or in Settings → Machines.'
    case 'not_a_member':
      return message?.includes('owner') ? 'Only an organization owner can do this.' : 'You are not a member of this organization.'
    case 'not_settings_manager':
      return 'Only an organization owner can change its settings.'
    case 'organization_not_found':
      return 'Solus Cloud does not know this organization.'
    case 'host_not_found':
      return 'Solus Cloud does not know this machine. Call list_cloud_machines to see the machines.'
    case 'refused_by_host_policy':
      return 'This organization\'s owners turned cloud hosts off. read_organization_policy shows its rules.'
    case 'managed_hosts_not_configured':
      return 'Solus Cloud cannot make cloud machines for this organization yet.'
    case 'rate_limited':
      return 'Too many tries. Wait a minute and try again.'
    case 'invalid_request':
      return `Solus Cloud refused the request${message ? `: ${message}` : ''}.`
    case 'managed_provisioning_failed':
      return 'Solus Cloud could not finish the change. Call the same tool again to finish it.'
    case 'unauthorized':
      return SIGN_IN
    default:
      return `Solus Cloud refused the request (${code ?? `HTTP ${status}`}${message ? `: ${message}` : ''}).`
  }
}

/** One request to Solus Cloud as the person; the answer parsed with `schema`, or one sentence that says why not. */
export async function cloudRequest<T>(
  person: CloudPerson,
  path: string,
  schema: z.ZodType<T>,
  init: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown } = {},
): Promise<CloudAnswer<T>> {
  if (!deps) return { ok: false, status: null, text: SIGN_IN }
  const request: RequestInit = { method: init.method ?? 'GET' }
  if (init.body !== undefined) {
    request.body = JSON.stringify(init.body)
    request.headers = { 'content-type': 'application/json' }
  }
  const response = await deps.reads.fetch(person.userId, person.scope, path, request)
  if ('refused' in response) return { ok: false, status: null, text: response.refused === 'NO_DELEGATION' ? SIGN_IN : response.message }
  const body: unknown = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) {
    const refusal = uplinkErrorBodySchema.safeParse(body)
    return { ok: false, status: response.status, body, text: refusalText(response.status, refusal.success ? refusal.data.error : null, refusal.success ? refusal.data.message ?? null : null) }
  }
  const parsed = schema.safeParse(body)
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, status: response.status, text: 'Solus Cloud gave an answer that this host cannot read. Update Solus, then try again.' }
}

export const readDirectory = (person: CloudPerson) => cloudRequest(person, '/v1/hosts', directoryResponseSchema)

export const failed = (text: string): AgentToolResult => ({ ok: false, text })
export const answered = <T>(value: T): AgentToolResult => ({ ok: true, text: JSON.stringify(value) })

/** The person's organizations, as their directory names them. */
export const organizationsOf = (directory: DirectoryResponse): CloudMachineOrganization[] =>
  directory.workspaces.map((workspace) => ({ id: workspace.organizationId, name: workspace.label }))

/**
 * The organization a call is for: the one named (an id or an exact name), else the
 * turn's, else the only one. `organization` is null when the person has several and
 * none is clear; `problem` says that the name matches none.
 */
export function chosenOrganization(person: CloudPerson, organizations: CloudMachineOrganization[], named: string | undefined): { organization: CloudMachineOrganization | null } | { problem: string } {
  const name = named?.trim().toLowerCase()
  if (name) {
    const organization = organizations.find((each) => each.id.toLowerCase() === name || each.name.toLowerCase() === name)
    return organization ? { organization } : { problem: `You have no organization "${named?.trim()}". Your organizations: ${organizationNames(organizations)}.` }
  }
  const turn = organizations.find((organization) => organization.id === person.organizationId)
  return { organization: turn ?? (organizations.length === 1 ? organizations[0]! : null) }
}

export const organizationNames = (organizations: CloudMachineOrganization[]): string => organizations.map((organization) => organization.name).join(', ') || 'none'

/** Shows the machine card and waits for its answer; null when the run stops first. */
async function askOnCard(context: AgentToolContext, ask: CloudMachineAsk): Promise<Record<string, string> | null> {
  const questionId = `cloud-machine-${crypto.randomUUID()}`
  const answers = await new Promise<Record<string, string> | null>((answer) => {
    const stopped = (): void => { stop(); answer(null) }
    const stop = answerToolQuestionWith(questionId, (values) => {
      context.abortSignal.removeEventListener('abort', stopped)
      answer(values)
    })
    if (context.abortSignal.aborted) { stopped(); return }
    context.abortSignal.addEventListener('abort', stopped, { once: true })
    const header = ask.mode === 'create' ? 'Create a cloud machine' : ask.mode === 'edit' ? 'Change a cloud machine' : 'Join a machine'
    context.emit({
      type: 'question_request',
      questionId,
      kind: 'cloud-machine',
      cloudMachine: ask,
      // A client that does not know the kind still shows what the agent asks.
      questions: [{ header, question: ask.reason, options: [], multiSelect: false }],
    })
  })
  // A `cloud-machine` answer is not a `question_answered`; this closes the card on every client.
  context.emit({ type: 'permission_resolved', questionId })
  return answers
}

/** The choice on the card, checked against the ask; a sentence when there is none. */
export async function choiceOnCard(context: AgentToolContext, ask: CloudMachineAsk): Promise<CloudMachineChoice | AgentToolResult> {
  const answers = await askOnCard(context, ask)
  if (!answers) return failed('The run stopped before the person chose. Nothing was changed.')
  const answer = readCloudMachineAnswer(ask, answers)
  if (!answer) return failed('The card gave an answer that is not one of its choices. Nothing was changed; call the tool again if the person still wants it.')
  if (answer.status === 'declined') return answered({ changed: false, declined: true, note: DECLINED })
  return answer.choice
}

const cloudMachinesOf = (directory: DirectoryResponse) => directory.hosts.filter((host) => host.kind === 'cloud')

const isThisHost = (host: DirectoryHost): boolean => {
  const self = deps?.thisHost()
  return !!self && (host.hostId === self.hostId || host.installationId === self.installationId)
}

const machineFacts = (host: DirectoryHost) => ({
  id: host.hostId,
  installationId: host.installationId,
  name: host.label,
  organizationIds: host.organizationIds,
  madeBySolus: host.hasManagedCompute === true,
  state: host.managedState ?? null,
  isThisHost: isThisHost(host),
})

const NOT_THIS_HOST = 'This is the host that runs this session. A host never changes, stops, restarts, or deletes itself: it would end this turn. Do it from another host, or in Settings → Machines.'

/** The machine a call names: an id, an installation id, or an exact name; a sentence when there is none, or it is this host. */
async function namedMachine(person: CloudPerson, named: string): Promise<{ host: DirectoryHost; directory: DirectoryResponse } | AgentToolResult> {
  const name = named.trim()
  const self = deps?.thisHost()
  // Refused before any request: a host never acts on itself (decisions 2 and 6).
  if (self && (name === self.hostId || name === self.installationId)) return failed(NOT_THIS_HOST)
  const directory = await readDirectory(person)
  if (!directory.ok) return failed(directory.text)
  const lower = name.toLowerCase()
  const matches = cloudMachinesOf(directory.value).filter((host) => host.hostId === name || host.installationId === name || host.label.toLowerCase() === lower)
  if (matches.length === 0) return failed(`No cloud machine is named "${name}". Call list_cloud_machines to see the machines.`)
  if (matches.length > 1) return failed(`Several cloud machines are named "${name}". Give the id from list_cloud_machines.`)
  const host = matches[0]!
  if (isThisHost(host)) return failed(NOT_THIS_HOST)
  return { host, directory: directory.value }
}

/** The person and the machine of a call, or the sentence that says why not. */
async function personAndMachine(context: AgentToolContext, named: string): Promise<{ person: CloudPerson; host: DirectoryHost; directory: DirectoryResponse } | AgentToolResult> {
  const person = await cloudPerson(context)
  if (!person) return failed(SIGN_IN)
  const found = await namedMachine(person, named)
  return 'host' in found ? { person, ...found } : found
}

const hostPath = (hostId: string, action: string) => `/v1/hosts/${encodeURIComponent(hostId)}/${action}`
const NOT_MADE_BY_SOLUS = 'Solus Cloud does not run this machine; only delete applies to it.'

const packagesField = z.array(z.string().max(128)).max(64).optional()
const setupScriptField = z.string().max(MAX_MANAGED_HOST_SETUP_SCRIPT_LENGTH).optional()
const hostField = z.string().min(1).max(200).describe('The machine: its id, installation id, or exact name from list_cloud_machines.')
const reasonField = z.string().min(1).max(300).describe('Why, in one sentence; a card shows it.')

/** Why packages or a script cannot go to Solus Cloud; null when they can. */
function specProblem(packages: string[] | undefined, catalog: ManagedHostCatalog | undefined, size?: string): string | null {
  if (packages) {
    const problem = cloudMachinePackagesProblem(packages)
    if (problem) return problem
  }
  if (size && catalog && !catalog.sizes.some((offered) => offered.id === size)) return `"${size}" is not a size. Sizes: ${catalog.sizes.map((offered) => offered.id).join(', ')}.`
  return null
}

/** The first host that `matches` in the directory, read until it lists one (the rule of `ManagedHostsStore.create`); null when it does not in time. */
async function listedSoon(person: CloudPerson, matches: (host: DirectoryHost) => boolean): Promise<DirectoryHost | null> {
  const { timeoutMs, pollMs } = deps?.listing ?? LISTING
  const deadline = Date.now() + timeoutMs
  while (true) {
    const read = await readDirectory(person)
    const listed = read.ok ? read.value.hosts.find(matches) : undefined
    if (listed) return listed
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

const NO_CATALOG: ManagedHostCatalog = { sizes: [], defaultSize: null, supportsPackages: true, supportsSetupScript: true }

const listFields = {
  organization: z.string().max(200).optional().describe('An organization id or name; all of them when absent.'),
}

export const listCloudMachinesAgentTool: AgentTool<typeof listFields> = {
  name: 'list_cloud_machines',
  description: 'List the cloud machines of your organizations: id, name, state, and whether Solus runs it. Also lists your organizations and the sizes a new machine can have. Call it before you change a machine.',
  inputFields: listFields,
  requiresApproval: false,
  isOffered: isCloudPersonOffered,
  async execute(input, context) {
    const person = await cloudPerson(context)
    if (!person) return failed(SIGN_IN)
    const directory = await readDirectory(person)
    if (!directory.ok) return failed(directory.text)
    const organizations = organizationsOf(directory.value)
    let machines = cloudMachinesOf(directory.value)
    if (input.organization?.trim()) {
      const chosen = chosenOrganization(person, organizations, input.organization)
      if ('problem' in chosen) return failed(chosen.problem)
      const { organization } = chosen
      if (organization) machines = machines.filter((host) => host.organizationIds.includes(organization.id))
    }
    const catalog = directory.value.managedHostCatalog
    return answered({
      machines: machines.map(machineFacts),
      organizations,
      sizes: catalog?.sizes.map(({ id, label, detail }) => ({ id, label, detail, isDefault: id === catalog.defaultSize })) ?? [],
    })
  },
}

const createFields = {
  organization: z.string().max(200).optional().describe('An organization id or name. Leave it out when the person did not say: a card asks when they have several.'),
  name: z.string().trim().min(1).max(120).optional(),
  size: z.string().max(64).optional().describe('A size id from list_cloud_machines; the default when absent.'),
  packages: packagesField.describe('apt packages to install, e.g. ["docker.io"].'),
  setup_script: setupScriptField.describe('A shell script that runs at the first boot, after the packages.'),
  reason: reasonField,
}

export const createCloudMachineAgentTool: AgentTool<typeof createFields> = {
  name: 'create_cloud_machine',
  description: 'Create a cloud machine that Solus runs for an organization, when the person asks for one (e.g. "make me a cloud machine with Docker"). Give the packages and script they asked for. Waits until the machine is listed, then returns it; use it with start_sessions.',
  inputFields: createFields,
  requiresApproval: false,
  isOffered: isCloudPersonOffered,
  async execute(input, context) {
    const person = await cloudPerson(context)
    if (!person) return failed(SIGN_IN)
    const directory = await readDirectory(person)
    if (!directory.ok) return failed(directory.text)
    const catalog = directory.value.managedHostCatalog
    const problem = specProblem(input.packages, catalog, input.size)
    if (problem) return failed(problem)
    const organizations = organizationsOf(directory.value)
    if (organizations.length === 0) return failed('You are in no organization. A cloud machine belongs to an organization.')
    const chosen = chosenOrganization(person, organizations, input.organization)
    if ('problem' in chosen) return failed(chosen.problem)
    let choice: CloudMachineChoice = { name: input.name, size: input.size, packages: input.packages, setupScript: input.setup_script }
    if (chosen.organization) choice.organizationId = chosen.organization.id
    else {
      const draft = Object.fromEntries(Object.entries(choice).filter(([, value]) => value !== undefined))
      const onCard = await choiceOnCard(context, { mode: 'create', reason: input.reason.trim(), organizations, catalog: catalog ?? NO_CATALOG, draft })
      if ('ok' in onCard) return onCard
      choice = onCard
    }
    const request: CreateManagedHostRequest = { organizationId: choice.organizationId! }
    if (choice.name) request.label = choice.name
    const spec = { size: choice.size, packages: choice.packages, setupScript: choice.setupScript }
    if (Object.values(spec).some((value) => value !== undefined)) request.spec = Object.fromEntries(Object.entries(spec).filter(([, value]) => value !== undefined))
    const created = await cloudRequest(person, '/v1/hosts', createManagedHostResponseSchema, { method: 'POST', body: request })
    if (!created.ok) return failed(created.text)
    const listed = await listedSoon(person, (host) => host.hostId === created.value.hostId)
    if (listed) return answered({ created: true, machine: machineFacts(listed), note: 'Use it with start_sessions.' })
    return answered({ created: true, machine: { id: created.value.hostId }, note: 'Solus Cloud made the machine, but the directory does not list it yet. Call list_cloud_machines in a minute.' })
  },
}

/** The change of packages and script; null when it changes nothing. */
function specChange(packages: string[] | undefined, setupScript: string | undefined): ManagedHostSpecChangeRequest | null {
  if (packages === undefined && setupScript === undefined) return null
  const change: ManagedHostSpecChangeRequest = {}
  if (packages !== undefined) change.packages = packages
  if (setupScript !== undefined) change.setupScript = setupScript
  return change
}

/** The edit card, with the machine's current spec; the person's choice, or the result that ends the call. */
async function changeOnCard(context: AgentToolContext, person: CloudPerson, host: DirectoryHost, directory: DirectoryResponse, reason: string): Promise<CloudMachineChoice | AgentToolResult> {
  const current = await cloudRequest(person, hostPath(host.hostId, 'spec'), managedHostSpecResponseSchema)
  if (!current.ok) return failed(current.text)
  const size = current.value.size
  const label = size ? directory.managedHostCatalog?.sizes.find((offered) => offered.id === size)?.label ?? size : null
  return choiceOnCard(context, {
    mode: 'edit',
    reason,
    host: { hostId: host.hostId, name: host.label, state: host.managedState ?? null, size: label },
    current: { packages: current.value.packages, setupScript: current.value.setupScript },
  })
}

const updateFields = {
  host: hostField,
  packages: packagesField.describe('The full list of apt packages; [] clears it. Leave it and setup_script out to let the person choose on a card.'),
  setup_script: setupScriptField.describe('The full setup script; "" clears it.'),
  reason: reasonField,
}

export const updateCloudMachineAgentTool: AgentTool<typeof updateFields> = {
  name: 'update_cloud_machine',
  description: 'Change the packages or setup script of a cloud machine that Solus runs. Give what the person asked for; with neither, a card shows the current ones so the person can edit them. A running machine restarts to take the change. Organization owners only. Never this host.',
  inputFields: updateFields,
  requiresApproval: false,
  isOffered: isCloudPersonOffered,
  async execute(input, context) {
    const found = await personAndMachine(context, input.host)
    if ('ok' in found) return found
    const { person, host, directory } = found
    if (!host.hasManagedCompute) return failed(NOT_MADE_BY_SOLUS)
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
  },
}

/** A lifecycle action on a machine that Solus runs. */
function lifecycleTool(name: string, action: 'start' | 'stop' | 'restart', description: string, schema: typeof managedHostStartResponseSchema): AgentTool<{ host: typeof hostField }> {
  return {
    name,
    description,
    inputFields: { host: hostField },
    requiresApproval: false,
    isOffered: isCloudPersonOffered,
    async execute(input, context) {
      const found = await personAndMachine(context, input.host)
      if ('ok' in found) return found
      if (!found.host.hasManagedCompute) return failed(NOT_MADE_BY_SOLUS)
      const result = await cloudRequest(found.person, hostPath(found.host.hostId, action), schema, { method: 'POST' })
      if (!result.ok) return failed(result.text)
      return answered({ machine: { ...machineFacts(found.host), state: result.value.lifecycle } })
    },
  }
}

export const startCloudMachineAgentTool = lifecycleTool('start_cloud_machine', 'start', 'Start a stopped cloud machine that Solus runs. It keeps its disk. It is ready for start_sessions when list_cloud_machines shows "ready".', managedHostStartResponseSchema)
export const stopCloudMachineAgentTool = lifecycleTool('stop_cloud_machine', 'stop', 'Stop a cloud machine that Solus runs, to save cost. It keeps its disk; start_cloud_machine brings it back. Never this host.', managedHostStopResponseSchema)
export const restartCloudMachineAgentTool = lifecycleTool('restart_cloud_machine', 'restart', 'Restart the Solus service of a running cloud machine that Solus runs, e.g. when it does not answer. The machine and its disk stay. Never this host.', managedHostRestartResponseSchema)

export const deleteCloudMachineAgentTool: AgentTool<{ host: typeof hostField }> = {
  name: 'delete_cloud_machine',
  description: 'Delete a cloud machine from its organization. A machine that Solus runs is destroyed with its disk; this cannot be undone. Only when the person asks. Organization owners only. Never this host.',
  inputFields: { host: hostField },
  // Deletion destroys the disk (decision 7).
  requiresApproval: true,
  isOffered: isCloudPersonOffered,
  async execute(input, context) {
    const found = await personAndMachine(context, input.host)
    if ('ok' in found) return found
    const result = await cloudRequest(found.person, hostPath(found.host.hostId, 'machine'), z.null(), { method: 'DELETE' })
    if (!result.ok) return failed(result.text)
    return answered({ deleted: true, machine: { id: found.host.hostId, name: found.host.label } })
  },
}

/**
 * The remote command of a join (plans/035 decision 8). The code comes on standard input
 * and goes into `SOLUS_LINK_CODE` of the setup process, which removes it at once
 * (`takeSetupLinkCode`): it is never an argument on either machine, where `ps` shows it.
 * The installer's folder is first on `PATH`: sshd's `PATH` leaves it out.
 */
export const JOIN_COMMAND = 'PATH="$HOME/.local/bin:$PATH" SOLUS_LINK_CODE="$(cat)" solus setup'
const JOIN_TIMEOUT_MS = 5 * 60_000
const MAX_OUTPUT = 4_000

const joinFields = {
  organization: z.string().max(200).optional().describe('An organization id or name; a card asks when it is not clear.'),
  address: z.string().min(1).max(2048).describe('The https:// address where members reach the machine.'),
  ssh_target: z.string().min(1).max(512).describe('e.g. ubuntu@3.91.20.4 or a ~/.ssh/config alias.'),
  identity_file: z.string().max(1024).optional().describe('A private key path on this host. Only the path.'),
  reason: reasonField,
}

/** The machine's origin, only when it is https. */
function httpsOrigin(address: string): string | null {
  try {
    const url = new URL(address.trim())
    return url.protocol === 'https:' && url.pathname === '/' && !url.search && !url.username ? url.origin : null
  } catch { return null }
}

/** The machine a join names: its https address and its SSH target; the sentence that refuses it otherwise. */
async function joinTarget(input: { address: string; ssh_target: string; identity_file?: string }, ssh: CloudMachineToolsDeps['ssh']): Promise<{ address: string; target: SshTarget } | AgentToolResult> {
  const address = httpsOrigin(input.address)
  if (!address) return failed('address must be an https:// origin with no path, for example https://build.example.com.')
  const resolved = resolveSshTarget(undefined, input.ssh_target)
  if (resolved.status !== 'ready') return failed('Give the SSH target, for example ubuntu@3.91.20.4.')
  const target = resolved.target
  const identityFile = input.identity_file?.trim()
  if (identityFile) {
    const key = checkIdentityFile(identityFile, 'this host')
    if (key.status !== 'ok') return failed(key.message)
    target.identityFile = identityFile
  }
  if (await ssh.resolvesToThisMachine(target)) return failed('That SSH target is this computer. Join another machine.')
  return { address, target }
}

export const joinCloudMachineAgentTool: AgentTool<typeof joinFields> = {
  name: 'join_cloud_machine',
  description: 'Join a Linux machine that the organization runs as its cloud machine: over SSH from this host, it runs `solus setup` with a new link code. The machine needs Solus installed, a new data directory, and an HTTPS address in front of it, and the organization must allow cloud hosts. Local owner of this host only.',
  inputFields: joinFields,
  requiresApproval: false,
  isOffered: isCloudPersonOffered,
  async execute(input, context) {
    const principal = workspaceToolAuthority()
    // The join uses this host's SSH keys: only its owner, at this host, as add_host.
    if (!principal || !isHostOwner(principal) || principal.via !== 'local' || !deps) return failed('Only the owner of this host, at this host, can join a machine over SSH.')
    const person = await cloudPerson(context)
    if (!person) return failed(SIGN_IN)
    const machine = await joinTarget(input, deps.ssh)
    if ('ok' in machine) return machine
    const { address, target } = machine
    const directory = await readDirectory(person)
    if (!directory.ok) return failed(directory.text)
    const organizations = organizationsOf(directory.value)
    const chosen = chosenOrganization(person, organizations, input.organization)
    if ('problem' in chosen) return failed(chosen.problem)
    let organizationId = chosen.organization?.id
    if (!organizationId) {
      const onCard = await choiceOnCard(context, { mode: 'join', reason: input.reason.trim(), organizations, address })
      if ('ok' in onCard) return onCard
      organizationId = onCard.organizationId
    }
    const origin = deps.accountOrigin()
    if (!origin || !organizationId) return failed('This host is not linked to Solus Cloud.')
    const ticket = await cloudRequest(person, '/v1/enrollment-tickets', enrollmentTicketResponseSchema, { method: 'POST', body: { organizationId } })
    if (!ticket.ok) return failed(ticket.text)
    // The code stays in this call: on the command's standard input, never in a result or a log.
    const code = formatLinkCode(ticket.value.ticket, origin)
    const known = new Set(directory.value.hosts.map((host) => host.hostId))
    const run = await deps.ssh.run(target, code, ['--address', address], { command: JOIN_COMMAND, acceptNewHostKey: true, timeoutMs: JOIN_TIMEOUT_MS })
    const output = `${run.stdout}\n${run.stderr}`.replaceAll(code, '[link code]').replaceAll(ticket.value.ticket, '[link code]').trim().slice(-MAX_OUTPUT)
    if (run.code !== 0) {
      const hint = isSshAuthFailure(output) ? ' SSH refused the keys of this host: use add_host, or give identity_file.' : ''
      return failed(`The join failed on ${input.ssh_target} (exit ${run.code}).${hint} The code was not used, and it ends in ten minutes. Output:\n${output}`)
    }
    const listed = await listedSoon(person, (host) => !known.has(host.hostId) && host.kind === 'cloud' && host.organizationIds.includes(organizationId))
    return answered({
      joined: true,
      machine: listed ? machineFacts(listed) : null,
      output,
      note: listed ? 'Use it with start_sessions.' : 'The command finished, but the directory does not list the machine yet. Call list_cloud_machines in a minute.',
    })
  },
}
