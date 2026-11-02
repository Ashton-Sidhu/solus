import { encodePathAsFolder, type AgentId, type SessionCtx } from '@solus/contracts/types'
import type { WorkspaceSessionAdmissionRequest } from '@solus/contracts/solus-api'
import { isHostOwner, LOCAL_ORGANIZATION_ID, type Principal } from '../../admission/principal'
import { ANY_ORGANIZATION } from '../../admission/principal'
import { assignSessionOrganization, getSessionRecord, isOrganizationWork } from '../../data/sessions/session-records'
import { claimSessionOwner, sessionIdentityOf, type SessionBirthOptions } from '../../data/sessions/session-identity'
import { isOrganizationAttached } from '../../host/organization-attachment'
import { sessionIdOfThread } from '../../data/sessions/session-lineage'
import { isChat } from '@solus/contracts/chat'
import { parseUserKey } from '@solus/contracts/user'
import { hostUserKey, isHostUserKey } from '../../host/host-user'
import type { HostOrganizations } from '../../host/organizations'
import { hostCategory } from '../../host/host-category'
import type { HostCategory } from '@solus/contracts/uplink'
import { ownerKeyOf, type Actor } from '../../admission/actor'
import type { TurnRefusal } from '@solus/contracts/organization-scope'
import { z } from 'zod'
import { TurnRefusedError } from './turn-refusal'

/**
 * What the organization model decides at the start of a turn
 * (organization-scope §3, §3.1, §6.1, R9–R11; organization-vms §1, §4):
 *
 * 1. **New root or continuation.** A turn of a session that already has a
 *    record (a row whose provider started) continues it under that record's
 *    saved home and organization. A brand-new session is a new root; a fork
 *    follows its source. The admission births the session's row
 *    (`session-identity.ts`): there is no in-memory record of a session that
 *    is not written yet, and a restart finds the same answer in the row.
 * 2. **Attached machine.** On a machine attached for organization work, a new
 *    root needs an organization — the member's, or the one the owner's window
 *    selected — and the Solus API must accept the session before its provider
 *    starts. The session is born published, owned by that person, and the host
 *    acts for them with its delegation. New personal roots are refused there; a session
 *    admitted before the attachment keeps its Local home.
 * 3. **Assignment.** Elsewhere, an unassigned Local session is assigned to the
 *    sending window's organization once: the organization of the person who
 *    started it. It is a fact about the session, not its home and not a share;
 *    only publication makes it organization work (`isOrganizationWork`). The
 *    Insights setting decides whether its Insights are sent
 *    (`insightsEligible`), not whether it is assigned. A session already
 *    assigned keeps its organization whatever the window selected.
 * 4. **Attribution.** The acting account behind the turn is the actor's user
 *    (`admission/actor.ts`): a member's own; the host's user for its owner (§6.1).
 */

/**
 * A refusal the delegation names, rather than an unreachable service. A delegation
 * whose client grant ended asks the person what a missing one does: sign in again.
 */
const delegationRefusalSchema = z.object({
  code: z.enum(['ORGANIZATION_ACCESS_REFUSED', 'ORGANIZATION_AUTHORITY_MISSING', 'ORGANIZATION_API_UNAVAILABLE', 'GRANT_REVOKED'])
    .transform((code): TurnRefusal => code === 'GRANT_REVOKED' ? 'ORGANIZATION_AUTHORITY_MISSING' : code),
})

/** How this host acts for a person in an organization (sync/delegations.ts; plans/010-standard-oauth.md). */
export interface DelegationPort {
  actFor(input: { sessionId: string; userId: string; organizationId: string; admit: boolean; record?: AdmittedRecord }): Promise<void>
}

/** The first facts of a new organization session, which the Solus API writes its record from when it admits it. */
type AdmittedRecord = NonNullable<WorkspaceSessionAdmissionRequest['record']>

export interface TurnOrganizationDeps {
  hostOrganizations: HostOrganizations
  /** Absent where the host cannot run organization work: the desktop's own host, a host with no link. */
  delegations?: DelegationPort
  /** Persists the attachment the first time a member is admitted for organization work (organization-vms §4). */
  markAttached?: () => void
  /** Gives a new organization session its owner and, unless it is a chat, the organization's editor grant on this machine (organization-vms §1; plan 004 D14). */
  adoptSession?: (sessionId: string, organizationId: string, ownerKey: string, options: { shareWithOrganization: boolean }) => Promise<void>
}

/**
 * What admission reads of a turn: its session and the organization the sender
 * works in. A prompt's `IpcContext` is one; a new session builds it from its
 * request (`PromptDispatch.createSession`), so every turn passes the same admission.
 */
export interface TurnAdmissionContext {
  session: Pick<SessionCtx, 'sessionId' | 'agentSessionId' | 'forked' | 'organizationId' | 'workingDirectory'> & { provider?: AgentId | null }
  /** The session that starts this one on this host (`start_session`): a child follows its record, as a fork follows its source. */
  parentSessionId?: string
}

/** The organization the turn's session belongs to after admission, `local` included. */
export async function admitTurnOrganization(ctx: TurnAdmissionContext, actor: Actor, deps: TurnOrganizationDeps): Promise<string> {
  const principal = actor.principal
  // A member reaches this machine only through a grant its attachment allows: the attachment is recorded before their work is admitted.
  if (principal.kind === 'org-member') deps.markAttached?.()
  // A fork follows the record of the session it branches from; a child, its parent's.
  const forkSource = ctx.session.forked && ctx.session.agentSessionId ? sessionIdOfThread(ctx.session.agentSessionId) : null
  const record = await getSessionRecord(ANY_ORGANIZATION, forkSource ?? ctx.parentSessionId ?? ctx.session.sessionId)
  const admitted = isOrganizationAttached()
    ? await admitOnAttachedMachine(ctx, principal, deps, record)
    : await admitOnPersonalMachine(ctx, principal, deps, record)
  // A new session belongs to the person its first turn is for (docs/plans/access-model.md §2.2):
  // a child session, an automation's run, and a client's new session alike; a turn nobody is
  // behind — a webhook's, an automation's — is the host's own. A guest starts none. The row is
  // born here, in the organization admission decided; a row that exists keeps its owner, and a
  // Local one born before its home was decided takes the home now.
  // A continuation of a started session has its row and its owner: nothing to claim.
  const continuing = !forkSource && ctx.parentSessionId === undefined && record !== null
  if (principal.kind !== 'guest' && ctx.session.sessionId) {
    await bornSession(ctx.session.sessionId, admitted, continuing, admitted.birth?.ownerKey ?? ownerKeyOf(actor) ?? hostUserKey())
  }
  return admitted.organizationId
}

/**
 * The row the turn's session is born with, in the organization admission decided
 * (`session-identity.ts`). A row born before this turn decided its home — Local,
 * by a claim or a start — takes the home once (R10). The owner never changes.
 */
async function bornSession(sessionId: string, admitted: TurnAdmission, continuing: boolean, ownerKey: string): Promise<void> {
  const claimed = continuing ? false : await claimSessionOwner(sessionId, { ownerKey, organizationId: admitted.organizationId }, admitted.birth)
  if (!claimed && admitted.decided && admitted.organizationId !== LOCAL_ORGANIZATION_ID) {
    await assignSessionOrganization(sessionId, admitted.organizationId, { published: admitted.birth?.published, admittedAt: admitted.birth?.admittedAt })
  }
}

type StoredRecord = Awaited<ReturnType<typeof getSessionRecord>>

/**
 * What admission decided for the turn's session: its organization; whether this
 * turn decided it (a new root), rather than read it from the row; and for a new
 * root the API admitted, how it is born.
 */
interface TurnAdmission {
  organizationId: string
  decided: boolean
  birth?: SessionBirthOptions & { ownerKey: string }
}

/**
 * An attached machine (organization-vms §1): an existing session continues where
 * it lives; a new root starts in an organization on the Solus API, or not at all.
 * A fork or a child is new work that follows the session it comes from.
 */
async function admitOnAttachedMachine(ctx: TurnAdmissionContext, principal: Principal, deps: TurnOrganizationDeps, record: StoredRecord): Promise<TurnAdmission> {
  const sessionId = ctx.session.sessionId
  const forked = ctx.session.forked === true || ctx.parentSessionId !== undefined
  if (record && !forked) {
    // A continuation keeps its saved home. An organization session on the Solus API
    // is the host acting for the person, and every token the host asks for checks them again,
    // so a removed membership or attachment stops new work.
    if (isOrganizationWork(record)) {
      await actForPerson(principal, deps, { sessionId, organizationId: record.organizationId, admit: false })
    }
    return { organizationId: record.organizationId, decided: false }
  }
  // A session the API admitted whose provider has not started: the row holds the admission, so a later prompt asks nothing more.
  const admitted = forked ? null : await sessionIdentityOf(sessionId)
  if (admitted?.admittedAt !== null && admitted?.admittedAt !== undefined) return { organizationId: admitted.organizationId, decided: false }
  // A fork follows its source: a personal session forks into personal work, which
  // uploads nothing; an organization session forks into a new organization session.
  // A child follows its parent the same way, for its parent's person.
  if (forked && record?.organizationId === LOCAL_ORGANIZATION_ID) return { organizationId: LOCAL_ORGANIZATION_ID, decided: true }
  const organizationId = forked && record ? record.organizationId : windowOrganization(ctx, principal)
  if (!organizationId) {
    throw new TurnRefusedError('ORGANIZATION_REQUIRED', 'This machine runs new work for an organization. Choose an organization in Solus, then send again.')
  }
  // A chat is still organization work, but only its owner sees it until they share it (plan 004 D14).
  const isPrivate = isChat(ctx.session.workingDirectory)
  // The API writes the session's record when it admits it, so the agent's first write that names the session finds it there.
  const provider = ctx.session.provider
  const firstFacts: AdmittedRecord | undefined = provider
    ? { provider, projectPath: encodePathAsFolder(ctx.session.workingDirectory), cwd: ctx.session.workingDirectory || null, privateToOwner: isPrivate }
    : undefined
  const userId = await actForPerson(principal, deps, { sessionId, organizationId, admit: true, record: firstFacts })
  await deps.adoptSession?.(sessionId, organizationId, userId, { shareWithOrganization: !isPrivate })
  // Born published, owned by the verified person, with the admission the API accepted (its id is the session's).
  return { organizationId, decided: true, birth: { ownerKey: userId, published: true, admittedAt: Date.now() } }
}

/** The organization a new root starts in on an attached machine: the member's own, or the owner's window selection. */
function windowOrganization(ctx: TurnAdmissionContext, principal: Principal): string | null {
  const selected = ctx.session.organizationId
  if (principal.kind === 'org-member') return !selected || selected === principal.organizationId ? principal.organizationId : null
  if (principal.kind !== 'owner' || principal.via !== 'grant') return null
  return selected && selected !== LOCAL_ORGANIZATION_ID ? selected : null
}

/**
 * The account this host acts for in a turn: a member's or the owner's own. A link
 * guest has none of its own: its turn on a session that exists runs for the person
 * who shared the link, on their seat (host-sharing.md §4.2 step 5; `seatFor`), so
 * it needs their authority. A guest never starts organization work.
 */
function accountActedFor(principal: Principal, deps: TurnOrganizationDeps, admit: boolean): string | null {
  if (principal.kind === 'org-member' || (principal.kind === 'owner' && principal.via === 'grant')) return principal.userId
  if (principal.kind !== 'guest' || admit) return null
  const sharer = principal.share.sharedByUserId
  if (isHostUserKey(sharer)) return deps.hostOrganizations.owner()?.userId ?? null
  const sharerId = parseUserKey(sharer)
  return sharerId.kind === 'account' ? sharerId.accountId : null
}

/**
 * This host acting for the person behind the turn. A pairing connection, a guest, or
 * the host itself has no account to act as, so it cannot start organization work.
 */
async function actForPerson(principal: Principal, deps: TurnOrganizationDeps, input: { sessionId: string; organizationId: string; admit: boolean; record?: AdmittedRecord }): Promise<string> {
  const userId = accountActedFor(principal, deps, input.admit)
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

/**
 * A person's own machine, and a server not attached: a new session takes the
 * organization of the person who starts it. A row that is Local — started or
 * born by a claim before this turn — is assigned it once (R10); a session with
 * no row yet is born in it by the claim that follows.
 */
async function admitOnPersonalMachine(ctx: TurnAdmissionContext, principal: Principal, deps: TurnOrganizationDeps, record: StoredRecord): Promise<TurnAdmission> {
  const sessionId = ctx.session.sessionId
  const organizationId = record?.organizationId ?? (await sessionIdentityOf(sessionId))?.organizationId ?? LOCAL_ORGANIZATION_ID
  if (organizationId !== LOCAL_ORGANIZATION_ID) return { organizationId, decided: false }
  const wanted = wantedOrganization(ctx, principal, deps)
  return wanted ? { organizationId: wanted, decided: true } : { organizationId: LOCAL_ORGANIZATION_ID, decided: false }
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
  if (!isOrganizationWork(record)) return true
  try {
    await actForPerson(principal, deps, { sessionId, organizationId: record.organizationId, admit: false })
    return true
  } catch {
    return false
  }
}

/**
 * The organization an unassigned session would be assigned to, or null to leave
 * it Local: the window's selection when the caller may name it.
 */
function wantedOrganization(ctx: TurnAdmissionContext, principal: Principal, deps: TurnOrganizationDeps): string | null {
  const selected = ctx.session.organizationId
  if (!selected || selected === LOCAL_ORGANIZATION_ID) return null
  if (principal.kind === 'org-member') return principal.organizationId === selected ? selected : null
  if (!isHostOwner(principal) && principal.kind !== 'system') return null
  return deps.hostOrganizations.organization(selected) ? selected : null
}

/**
 * A child or a fork works for the organization of the session it came from
 * (plans/018 §6). Its own row takes that organization once (R10), so a
 * restart finds it there: a row not born yet is born in it, as the host's own,
 * and a Local one is assigned it. A row already in an organization keeps it.
 */
export async function inheritSessionOrganization(sessionId: string, organizationId: string): Promise<void> {
  const born = await claimSessionOwner(sessionId, { ownerKey: hostUserKey(), organizationId })
  if (!born) await assignSessionOrganization(sessionId, organizationId)
}

/** Why unattended organization work may not start from this host, for the person who set it up. */
export interface UnattendedWorkRefusal {
  code: TurnRefusal
  message: string
}

/**
 * Why work that starts with no person at the keyboard — the actions of a webhook —
 * may not start in `organizationId` from this host; null when it may
 * (docs/plans/webhooks.md §2.7, §3.7). A webhook is checked when it is saved, so the
 * person who sets it up hears the refusal then, not on a delivery later. It reads the
 * policy where admission reads the host's organizations: `HostOrganizations.policyFor`.
 * Local work has no policy.
 */
export function unattendedOrganizationRefusal(
  organizationId: string,
  organizations: Pick<HostOrganizations, 'policyFor'>,
  work: { unverified: boolean },
  category: HostCategory = hostCategory(),
): UnattendedWorkRefusal | null {
  const policy = organizations.policyFor(organizationId)
  if (!policy) return null
  if (category === 'personal' && !policy.allowsPersonalHosts) {
    return { code: 'PERSONAL_HOSTS_NOT_ALLOWED', message: 'This organization does not allow its work to start on a personal computer. Set up the webhook on a cloud or self-hosted machine of the organization.' }
  }
  if (work.unverified && policy.allowsUnverifiedWebhooks !== true) {
    return { code: 'ORGANIZATION_NOT_ALLOWED', message: 'This organization does not allow unverified webhooks. Choose a verification scheme.' }
  }
  return null
}
