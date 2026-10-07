import type { IpcContext } from '@solus/contracts/types'
import { isHostOwner, LOCAL_ORGANIZATION_ID, type Principal } from '../../admission/principal'
import { ANY_ORGANIZATION } from '../../admission/principal'
import { assignSessionOrganization, getSessionRecord, rememberSessionBirth, type SessionBirth } from '../../data/sessions/session-records'
import { isOrganizationAttached } from '../../host/organization-attachment'
import { sessionIdOfThread } from '../../data/sessions/session-lineage'
import { isChat } from '@solus/contracts/chat'
import type { HostOrganizations } from '../../host/organizations'
import { insightsEligible } from '../../sync/mirror/insight-mirror'
import type { Actor } from '../../admission/actor'
import type { TurnRefusal } from '@solus/contracts/organization-scope'
import { z } from 'zod'
import { TurnRefusedError } from './turn-refusal'

/**
 * What the organization model decides at the start of a turn
 * (organization-scope §3, §3.1, §6.1, R9–R11; organization-vms §1, §4):
 *
 * 1. **New root or continuation.** A turn of a session that already has a
 *    record continues it under that record's saved home and organization. A
 *    brand-new session is a new root; a fork follows its source.
 * 2. **Attached machine.** On a machine attached for organization work, a new
 *    root needs an organization — the member's, or the one the owner's window
 *    selected — and the Solus API must accept the session before its provider
 *    starts. The session is born published, owned by that person, and the host
 *    acts for them with its delegation. New personal roots are refused there; a session
 *    admitted before the attachment keeps its Local home.
 * 3. **Assignment.** Elsewhere, an unassigned Local session is assigned to the
 *    sending window's organization once — only when that organization's
 *    Insights would leave this machine, because that is what the assignment is
 *    for. A session already assigned keeps its organization whatever the window
 *    selected.
 * 4. **Allowed host.** A session of an organization that refuses personal
 *    hosts does not run on a personal machine (§3.1), not even for the owner.
 * 5. **Attribution.** The acting account behind the turn is the actor's user
 *    (`admission/actor.ts`): a member's own; the host's user for its owner (§6.1).
 */

/** A refusal the delegation names, rather than an unreachable service. */
const delegationRefusalSchema = z.object({ code: z.enum(['ORGANIZATION_ACCESS_REFUSED', 'ORGANIZATION_AUTHORITY_MISSING', 'ORGANIZATION_API_UNAVAILABLE']) })

/** How this host acts for a person in an organization (sync/delegations.ts; plans/010-standard-oauth.md). */
export interface DelegationPort {
  actFor(input: { sessionId: string; userId: string; organizationId: string; admit: boolean }): Promise<void>
}

export interface TurnOrganizationDeps {
  hostOrganizations: HostOrganizations
  /** Absent where the host cannot run organization work: the desktop's own host, a host with no link. */
  delegations?: DelegationPort
  /** Persists the attachment the first time a member is admitted for organization work (organization-vms §4). */
  markAttached?: () => void
  /** Gives a new organization session its owner and, unless it is a chat, the organization's editor grant on this machine (organization-vms §1; plan 004 D14). */
  adoptSession?: (sessionId: string, organizationId: string, ownerUserId: string, options: { shareWithOrganization: boolean }) => Promise<void>
}

/** The organization the turn's session belongs to after admission, `local` included. */
export async function admitTurnOrganization(ctx: IpcContext, actor: Actor, deps: TurnOrganizationDeps): Promise<string> {
  const principal = actor.principal
  // A member reaches this machine only through a grant its attachment allows: the attachment is recorded before their work is admitted.
  if (principal.kind === 'org-member') deps.markAttached?.()
  // A fork follows the record of the session it branches from.
  const forkSource = ctx.session.forked && ctx.session.agentSessionId ? sessionIdOfThread(ctx.session.agentSessionId) : null
  const record = await getSessionRecord(ANY_ORGANIZATION, forkSource ?? ctx.session.sessionId)
  const organizationId = isOrganizationAttached()
    ? await admitOnAttachedMachine(ctx, principal, deps, record)
    : await admitOnPersonalMachine(ctx, principal, deps, record)
  if (organizationId !== LOCAL_ORGANIZATION_ID && !deps.hostOrganizations.mayExecute(organizationId)) {
    throw new TurnRefusedError('PERSONAL_HOSTS_NOT_ALLOWED', `${deps.hostOrganizations.organization(organizationId)?.name ?? 'This organization'} does not allow its work to run on a personal computer. Use a self-hosted server or a cloud host.`)
  }
  return organizationId
}

type StoredRecord = Awaited<ReturnType<typeof getSessionRecord>>

/**
 * An attached machine (organization-vms §1): an existing session continues where
 * it lives; a new root starts in an organization on the Solus API, or not at all.
 */
async function admitOnAttachedMachine(ctx: IpcContext, principal: Principal, deps: TurnOrganizationDeps, record: StoredRecord): Promise<string> {
  const sessionId = ctx.session.sessionId
  const forked = ctx.session.forked === true
  const pending = pendingAssignments.get(sessionId)
  if (pending) return pending.organizationId
  if (record && !forked) {
    // A continuation keeps its saved home. An organization session on the Solus API
    // is the host acting for the person, and every token refresh checks them again,
    // so a removed membership or attachment stops new work.
    if (record.organizationId !== LOCAL_ORGANIZATION_ID && record.publication === 'published') {
      await actForPerson(principal, deps, { sessionId, organizationId: record.organizationId, admit: false })
    }
    return record.organizationId
  }
  // A fork follows its source: a personal session forks into personal work, which
  // uploads nothing; an organization session forks into a new organization session.
  if (forked && record?.organizationId === LOCAL_ORGANIZATION_ID) return LOCAL_ORGANIZATION_ID
  const organizationId = forked && record ? record.organizationId : windowOrganization(ctx, principal)
  if (!organizationId) {
    throw new TurnRefusedError('ORGANIZATION_REQUIRED', 'This machine runs new work for an organization. Choose an organization in Solus, then send again.')
  }
  const userId = await actForPerson(principal, deps, { sessionId, organizationId, admit: true })
  // A chat is still organization work, but only its owner sees it until they share it (plan 004 D14).
  await deps.adoptSession?.(sessionId, organizationId, userId, { shareWithOrganization: !isChat(ctx.session.workingDirectory) })
  const birth: SessionBirth = { organizationId, published: true, ownerUserId: userId, admissionId: sessionId }
  pendingAssignments.set(sessionId, birth)
  rememberSessionBirth(sessionId, birth)
  return organizationId
}

/** The organization a new root starts in on an attached machine: the member's own, or the owner's window selection. */
function windowOrganization(ctx: IpcContext, principal: Principal): string | null {
  const selected = ctx.session.organizationId
  if (principal.kind === 'org-member') return !selected || selected === principal.organizationId ? principal.organizationId : null
  if (principal.kind !== 'remote-owner') return null
  return selected && selected !== LOCAL_ORGANIZATION_ID ? selected : null
}

/**
 * This host acting for the person behind the turn. A pairing connection, a guest, or
 * the host itself has no account to act as, so it cannot start organization work.
 */
async function actForPerson(principal: Principal, deps: TurnOrganizationDeps, input: { sessionId: string; organizationId: string; admit: boolean }): Promise<string> {
  const userId = principal.kind === 'org-member' || principal.kind === 'remote-owner' ? principal.userId : null
  if (!userId) {
    if (principal.kind === 'system' && !input.admit) return ''
    throw new TurnRefusedError('ORGANIZATION_REQUIRED', 'Organization work on this machine needs your Solus account. Connect through Solus with an organization selected.')
  }
  if (!deps.delegations) throw new TurnRefusedError('ORGANIZATION_API_UNAVAILABLE', 'This machine is not linked to a Solus API. Link it again to run organization work.')
  try {
    await deps.delegations.actFor({ ...input, userId })
  } catch (error) {
    // The delegation says why it refused; anything else is the API or account plane being unreachable.
    const refused = delegationRefusalSchema.safeParse(error)
    const refusal: TurnRefusal = refused.success ? refused.data.code : 'ORGANIZATION_API_UNAVAILABLE'
    throw new TurnRefusedError(refusal, error instanceof Error ? error.message : String(error))
  }
  return userId
}

/** A person's own machine, and a server not attached: scratch stays Local unless its Insights assignment applies. */
async function admitOnPersonalMachine(ctx: IpcContext, principal: Principal, deps: TurnOrganizationDeps, record: StoredRecord): Promise<string> {
  const sessionId = ctx.session.sessionId
  let organizationId = record?.organizationId ?? pendingAssignments.get(sessionId)?.organizationId ?? LOCAL_ORGANIZATION_ID
  if (organizationId !== LOCAL_ORGANIZATION_ID) return organizationId
  const wanted = wantedOrganization(ctx, principal, deps)
  if (wanted && record) {
    const assigned = await assignSessionOrganization(sessionId, wanted)
    organizationId = assigned?.organizationId ?? organizationId
  } else if (wanted) {
    // No record yet (a brand-new session): the record is born in it, and the
    // runtime applies it at session_init (`applyPendingAssignment`).
    pendingAssignments.set(sessionId, { organizationId: wanted })
    rememberSessionBirth(sessionId, { organizationId: wanted })
    organizationId = wanted
  }
  return organizationId
}

/**
 * Whether this person may answer a new approval or question of a session
 * (organization-vms §4): on an attached machine the host must be able to act for
 * them in the session's organization, so a person whose membership or the machine's
 * attachment was removed cannot let a run continue past a new question.
 */
export async function mayAnswerFor(principal: Principal, sessionId: string, deps: TurnOrganizationDeps): Promise<boolean> {
  if (!isOrganizationAttached()) return true
  const record = await getSessionRecord(ANY_ORGANIZATION, sessionId)
  if (!record || record.organizationId === LOCAL_ORGANIZATION_ID || record.publication !== 'published') return true
  try {
    await actForPerson(principal, deps, { sessionId, organizationId: record.organizationId, admit: false })
    return true
  } catch {
    return false
  }
}

/**
 * The organization an unassigned session would be assigned to, or null to leave
 * it Local: the window's selection when the caller may name it and that
 * organization's Insights apply here.
 */
function wantedOrganization(ctx: IpcContext, principal: Principal, deps: TurnOrganizationDeps): string | null {
  const selected = ctx.session.organizationId
  if (!selected || selected === LOCAL_ORGANIZATION_ID) return null
  if (principal.kind === 'org-member') return principal.organizationId === selected && insightsEligible(selected) ? selected : null
  if (!isHostOwner(principal) && principal.kind !== 'system') return null
  if (!deps.hostOrganizations.organization(selected)) return null
  return insightsEligible(selected) ? selected : null
}

/**
 * Sessions admitted for an organization before their record existed. The
 * runtime calls `applyPendingAssignment` at session_init.
 */
const pendingAssignments = new Map<string, SessionBirth>()

/** The organization a session was admitted for before its record existed, if any. */
export function pendingOrganizationFor(sessionId: string): string | null {
  return pendingAssignments.get(sessionId)?.organizationId ?? null
}

/**
 * A child or a fork works for the organization of the session it came from
 * (plans/018 §6). Its own record takes that organization once (R10), so a
 * restart finds it there and not in memory. An admission already pending for
 * the session is left as it is.
 */
export async function inheritSessionOrganization(sessionId: string, organizationId: string): Promise<void> {
  if (pendingAssignments.has(sessionId)) return
  // Whichever comes first: a record not written yet is born in it, a Local one is assigned it.
  rememberSessionBirth(sessionId, { organizationId })
  await assignSessionOrganization(sessionId, organizationId)
}

/** At session_init: the record now exists, so an admission that waited for it is applied. */
export function applyPendingAssignment(sessionId: string): void {
  const birth = pendingAssignments.get(sessionId)
  if (!birth) return
  pendingAssignments.delete(sessionId)
  // Whichever write comes first wins the same way: a record born now starts in
  // its home, a record the indexer already wrote as Local is assigned it.
  void assignSessionOrganization(sessionId, birth.organizationId, birth)
}

