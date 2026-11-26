import { permissionsAllow } from '@solus/contracts/permissions'
import { readAddMachineOutcome, type AddMachineAsk } from '@solus/contracts/add-machine'
import { normalizeServerUrl } from '@solus/client-core/pairing'
import { z } from 'zod'
import { isHostOwner } from '../../../admission/principal'
import { workspaceToolAuthority } from '../../../admission/workspace-tool-authority'
import { permissionsFor } from '../../../admission/access-policy'
import type { HostPairings } from '../../../host/host-pairings'
import type { ListedRemoteHost } from '../../orchestration/remote-hosts'
import { answerToolQuestionWith } from '../../sessions/input-requests'
import { listedRemoteHosts } from './session-tools'
import type { AgentTool, AgentToolContext, AgentToolResult } from './agent-tool'
import { joinMachine } from './cloud-machine-tools'

let pairings: HostPairings | null = null
export function setHostPairingTools(next: HostPairings | null): void { pairings = next }

function forOwner(): HostPairings {
  const principal = workspaceToolAuthority()
  // No ambient/system fallback: a background agent cannot create owner access.
  if (!principal || !isHostOwner(principal) || principal.via !== 'local') throw new Error('Only a locally authorized owner session can manage host pairings.')
  if (!permissionsAllow(permissionsFor(principal), 'host.local.reach')) throw new Error('This host does not allow local host reach.')
  if (!pairings) throw new Error('Host pairing is not available on this server.')
  return pairings
}

/** The origin of an address the agent was given; a pair link's token or a path is dropped. */
function askedOrigin(url: string): string {
  const parsed = new URL(normalizeServerUrl(url))
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('url must be an http or https address, for example http://10.10.1.10:3000.')
  return parsed.origin
}

function originOf(url: string): string | null {
  try { return new URL(normalizeServerUrl(url)).origin } catch { return null }
}

/** An online host that the ask names: by its address, or by its exact name or id. */
function reachedMatch(hosts: ListedRemoteHost[], ask: AddMachineAsk): ListedRemoteHost | undefined {
  const hint = ask.hint?.trim().toLowerCase()
  return hosts.find((host) => host.status === 'online' && (
    (ask.url !== undefined && host.routes.some((route) => originOf(route.url) === ask.url))
    || (!!hint && [host.name, host.id, host.installationId].some((name) => name.toLowerCase() === hint))
  ))
}

const hostFacts = ({ id, installationId, name, status, source }: ListedRemoteHost) => ({ id, installationId, name, status, source })

/** Shows the Add machine card and waits for its answer; null when the run stops first. */
async function askOnCard(context: AgentToolContext, ask: AddMachineAsk): Promise<Record<string, string> | null> {
  const questionId = `host-link-${crypto.randomUUID()}`
  const answers = await new Promise<Record<string, string> | null>((answer) => {
    const stopped = (): void => { stop(); answer(null) }
    const stop = answerToolQuestionWith(questionId, (values) => {
      context.abortSignal.removeEventListener('abort', stopped)
      answer(values)
    })
    if (context.abortSignal.aborted) { stopped(); return }
    context.abortSignal.addEventListener('abort', stopped, { once: true })
    context.emit({
      type: 'question_request',
      questionId,
      kind: 'host-link',
      hostLink: ask,
      // A client that does not know the kind still shows what the agent asks.
      questions: [{ header: 'Add a machine', question: ask.reason, options: [], multiSelect: false }],
    })
  })
  // A `host-link` answer is not a `question_answered`; this closes the card on every client.
  context.emit({ type: 'permission_resolved', questionId })
  return answers
}

const addHostFields = {
  hint: z.string().max(200).optional().describe('The person\'s words, e.g. "my windows machine".'),
  url: z.string().max(2048).optional().describe('Its Solus address, e.g. http://10.10.1.10:3000.'),
  ssh_target: z.string().max(512).optional().describe('An SSH target the person gave, e.g. ubuntu@3.91.20.4 or a ~/.ssh/config alias. The card fills it in.'),
  identity_file: z.string().max(1024).optional().describe('A private key path on this host the person gave, e.g. ~/.ssh/aws.pem. Only the path; never read or send the key.'),
  reason: z.string().min(1).max(300).describe('Why, in one sentence; the card shows it.'),
  organization: z.string().max(200).optional().describe('Join the machine as a cloud machine of this organization (id or name; "ask" lets the person choose on a card), over SSH: give url (its https address) and ssh_target. Signed in only.'),
}

/** `add_host` with an organization: the join of a machine that the organization runs (`joinMachine`). */
function joinAsCloudMachine(input: z.output<z.ZodObject<typeof addHostFields>>, context: AgentToolContext): Promise<AgentToolResult> {
  if (!input.url?.trim() || !input.ssh_target?.trim()) return Promise.resolve({ ok: false, text: 'To join a machine to an organization, give url (its https:// address) and ssh_target.' })
  const organization = input.organization?.trim() ?? ''
  return joinMachine.execute({
    organization: organization.toLowerCase() === 'ask' ? undefined : organization,
    address: input.url,
    ssh_target: input.ssh_target,
    identity_file: input.identity_file,
    reason: input.reason,
  }, context)
}

/** `add_host` without an organization: pair a machine through the Add machine card. */
async function addPairedHost(input: z.output<z.ZodObject<typeof addHostFields>>, context: AgentToolContext): Promise<AgentToolResult> {
  try {
    forOwner()
    const sessionId = context.sessionId()
    if (!sessionId) throw new Error('add_host needs a session.')
    const ask: AddMachineAsk = { reason: input.reason.trim() }
    if (input.hint?.trim()) ask.hint = input.hint.trim()
    if (input.url?.trim()) ask.url = askedOrigin(input.url)
    if (input.ssh_target?.trim()) ask.sshTarget = input.ssh_target.trim()
    if (input.identity_file?.trim()) ask.identityFile = input.identity_file.trim()
    const reached = reachedMatch(await listedRemoteHosts(sessionId) ?? [], ask)
    if (reached) return { ok: true, text: JSON.stringify({ added: false, alreadyReached: true, host: hostFacts(reached), note: 'This host already reaches that machine, so no card was shown. Use it with start_sessions.' }) }
    const answers = await askOnCard(context, ask)
    if (!answers) return { ok: false, text: 'The run stopped before a machine was added.' }
    const outcome = readAddMachineOutcome(answers)
    if (!outcome) return { ok: false, text: 'The card gave an answer that names no machine. Nothing was added; call add_host again if the person still wants it.' }
    if (outcome.status === 'declined') return { ok: true, text: JSON.stringify({ added: false, declined: true, note: 'The person declined. Do not ask again unless they ask you to.' }) }
    // The answer comes from a client: return only a host that this host now holds a credential for.
    const host = (await listedRemoteHosts(sessionId) ?? []).find((listed) => listed.installationId === outcome.installationId && listed.source !== 'listed')
    if (!host) return { ok: false, text: 'The card said a machine was added, but this host holds no record for it. Nothing was added; call add_host again.' }
    return { ok: true, text: JSON.stringify({ added: true, way: outcome.way, host: hostFacts(host), note: 'Agents here can use this host with start_sessions.' }) }
  } catch (error) { return { ok: false, text: error instanceof Error ? error.message : 'Could not add the machine.' } }
}

export const addHostAgentTool: AgentTool<typeof addHostFields> = {
  name: 'add_host',
  description: 'Add another Solus host (a machine) for agent work. Shows the person an Add machine card: SSH from this host, an approval request, or a pairing code. Never ask for a code, password, or link in chat or with request_secret. Pass the person\'s words as hint, the address as url, and an SSH target and key path as ssh_target and identity_file when known. No label: the host\'s own name is used. With organization, joins it as a cloud machine of that organization instead. Returns the added host, or one already reached. Local owner only. remove_host forgets.',
  inputFields: addHostFields,
  // The card is the person's consent: nothing is added until they choose a machine on it, and Decline closes it.
  requiresApproval: false,
  // With an organization, the machine joins as its cloud machine (plans/036 §3).
  execute: (input, context) => input.organization?.trim() ? joinAsCloudMachine(input, context) : addPairedHost(input, context),
}

export const removeHostAgentTool: AgentTool = {
  name: 'remove_host',
  description: 'Forget a host here by installationId from list_hosts or add_host. Clears credentials and forwards; connected owner clients forget it too. The remote server and sessions stay. Add it again to restore access.',
  inputFields: { installationId: z.string().min(1) }, requiresApproval: true,
  async execute(input) {
    try { return { ok: true, text: JSON.stringify({ removed: forOwner().forget(input.installationId) }) } }
    catch (error) { return { ok: false, text: error instanceof Error ? error.message : 'Could not forget the host.' } }
  },
}
