import { workspaceLinkDeleteSchema, workspaceLinkSchema } from '@solus/contracts/solus-api'
import type { WorkspaceLink, WorkspaceLinkDelete, WorkspaceLinkTarget } from '@solus/contracts/solus-api'
import type { SessionRecord } from '@solus/contracts/types'
import { pullRequestIdentityOf } from '@solus/contracts/session-pull-requests'
import type { Attribution } from '@solus/contracts/user'
import type { WorkspaceRequestContext } from '../../admission/workspace-credentials'
import { SolusApiError } from '../../admission/workspace-error'
import type { ShareManager } from '../../sharing/share-manager'
import { isApiMode } from '../../host/api-mode'
import { apiScope, requireResource, requireScope, writerAttribution } from '../workspace/context'
import { Task } from '../tasks/task'
import { Work } from '../works/work'
import { automationHomeOf } from '../automations/automations-store'
import { getSessionRecord } from '../sessions/session-records'
import { linkSessionItem, unlinkSessionItem } from '../sessions/session-links'
import { linkSessionPullRequest, unlinkSessionPullRequest } from '../sessions/session-pull-requests'

/**
 * One route links a task or a session to another record (`PUT /links`, `DELETE /links`).
 * Every link needs editor on `from`. The rule of each (from, to) pair checks its
 * target — readable, and in the organization of `from` — and writes the table that
 * pair has always used, through the store functions that emit its activity and events.
 */

type TargetKind = WorkspaceLinkTarget['kind']
type TargetOf<K extends TargetKind> = Extract<WorkspaceLinkTarget, { kind: K }>

/** What a rule reads: the checked `from`, with the organization it lives in. */
interface LinkRequest<From, K extends TargetKind> {
  context: WorkspaceRequestContext
  shares: ShareManager
  from: From
  organizationId: string
  to: TargetOf<K>
  title?: string
  role?: 'working' | 'referenced'
  originSessionId?: string
  by: Attribution
}

interface LinkRule<From, K extends TargetKind> {
  /** Refuses a target the caller may not link. A put runs it; a delete does not. */
  check(request: LinkRequest<From, K>): Promise<void>
  put(request: LinkRequest<From, K>): Promise<void>
  delete(request: LinkRequest<From, K>): Promise<void>
}

type TaskRules = { [K in 'work' | 'plan' | 'pr' | 'automation' | 'session']: LinkRule<Task, K> }
type SessionRules = { [K in 'work' | 'file' | 'automation' | 'pr']: LinkRule<SessionRecord, K> }

const sameOrganization = () => new SolusApiError(400, 'INVALID_REQUEST', 'Both ends of a link belong to one organization.')

function pullRequestOf(url: string): { repository: string; number: number; url: string } {
  const identity = pullRequestIdentityOf(url)
  if (!identity) throw new SolusApiError(400, 'INVALID_REQUEST', 'The URL does not name a pull request.')
  return identity
}

/** What a target check reads of a request. */
type Checked = Pick<LinkRequest<unknown, TargetKind>, 'context' | 'shares' | 'organizationId'>

async function readableWork(request: Checked, workId: string, verb: 'read' | 'edit'): Promise<void> {
  await requireResource(request.shares, request.context, { kind: 'work', id: workId }, verb)
  if (!await Work.find(request.organizationId, workId)) throw sameOrganization()
}

async function readableSession(request: Checked, sessionId: string): Promise<void> {
  await requireResource(request.shares, request.context, { kind: 'session', id: sessionId }, 'read')
  if (!await getSessionRecord(request.organizationId, sessionId)) throw sameOrganization()
}

/**
 * An automation this home keeps must be readable and in the organization of `from`.
 * The Solus API keeps none: an automation is its host's, and the link names that host.
 */
async function readableAutomation(request: Checked, automation: TargetOf<'automation'>): Promise<void> {
  const home = isApiMode() ? null : automationHomeOf(automation.id)
  if (!home) {
    if (!automation.hostId) throw new SolusApiError(404, 'NOT_FOUND', 'Automation not found.')
    return
  }
  await requireResource(request.shares, request.context, { kind: 'automation', id: automation.id }, 'read')
  if (home.organizationId !== request.organizationId) throw sameOrganization()
}

/** The host that holds a session's file or automation: its execution host. */
function sessionHostOf(request: Pick<LinkRequest<SessionRecord, TargetKind>, 'context' | 'from'>, named: string | undefined): string {
  const hostId = named ?? request.from.runnerHostId ?? (request.context.home.kind === 'local' ? request.context.home.hostId : null)
  if (!hostId) throw new SolusApiError(400, 'INVALID_REQUEST', 'Name the host that holds the target.')
  if (request.from.runnerHostId && hostId !== request.from.runnerHostId) throw new SolusApiError(400, 'INVALID_REQUEST', 'The target must belong to the session\'s execution host.')
  return hostId
}

const TASK_RULES: TaskRules = {
  work: {
    check: request => readableWork(request, request.to.id, 'read'),
    put: async ({ from, to, title, originSessionId, by }) => { await from.linkWork(to.id, by, { title, originSessionId }) },
    delete: async ({ from, to, by }) => { await from.unlink('work', to.id, '', by) },
  },
  plan: {
    check: request => readableSession(request, request.to.sessionId),
    put: async ({ from, to, title, originSessionId, by }) => { await from.linkPlan(to.sessionId, to.planId, by, { title, originSessionId }) },
    delete: async ({ from, to, by }) => { await from.unlink('plan', to.planId, to.sessionId, by) },
  },
  pr: {
    check: async ({ to }) => { pullRequestOf(to.url) },
    put: async ({ from, to, title, originSessionId, by }) => {
      const identity = pullRequestOf(to.url)
      // A pull request of a session that works on the task is that session's link, which the task reads.
      if (originSessionId && await from.linkWorkingSessionPullRequest(originSessionId, { url: identity.url, title }, by)) return
      await from.link({ kind: 'pr', targetScope: identity.repository, targetKey: String(identity.number), title, url: identity.url, originSessionId }, by)
    },
    delete: async ({ from, to, by }) => {
      const identity = pullRequestOf(to.url)
      await from.unlink('pr', String(identity.number), identity.repository, by)
    },
  },
  automation: {
    check: request => readableAutomation(request, request.to),
    put: async ({ from, to, title, originSessionId, by }) => { await from.linkAutomation(to.id, by, { title, originSessionId }) },
    delete: async ({ from, to, by }) => { await from.unlink('automation', to.id, '', by) },
  },
  session: {
    check: request => readableSession(request, request.to.id),
    put: async ({ from, to, role }) => { await from.linkSession(to.id, role ?? 'working') },
    delete: async ({ from, to, by }) => { await from.unlinkSession(to.id, by) },
  },
}

const SESSION_RULES: SessionRules = {
  // Linking a session writes the work's own record, so it needs editor on the work.
  work: {
    check: request => readableWork(request, request.to.id, 'edit'),
    put: ({ from, to, title, by }) => linkSessionItem(from.sessionId, { target: { kind: 'work', targetId: to.id }, title }, by),
    delete: ({ from, to }) => unlinkSessionItem(from.sessionId, { kind: 'work', targetId: to.id }),
  },
  file: {
    check: async request => { sessionHostOf(request, request.to.hostId) },
    put: request => linkSessionItem(request.from.sessionId, { target: { kind: 'file', path: request.to.path, hostId: sessionHostOf(request, request.to.hostId) }, title: request.title }, request.by),
    delete: request => unlinkSessionItem(request.from.sessionId, { kind: 'file', path: request.to.path, hostId: sessionHostOf(request, request.to.hostId) }),
  },
  automation: {
    check: async request => { sessionHostOf(request, request.to.hostId); await readableAutomation(request, request.to) },
    put: request => linkSessionItem(request.from.sessionId, { target: { kind: 'automation', targetId: request.to.id, hostId: sessionHostOf(request, request.to.hostId) }, title: request.title }, request.by),
    delete: request => unlinkSessionItem(request.from.sessionId, { kind: 'automation', targetId: request.to.id, hostId: sessionHostOf(request, request.to.hostId) }),
  },
  // A session's pull request keeps its own rules: a removed one stays removed (a
  // tombstone PR sync respects), and linking or removing starts or stops its watch.
  pr: {
    check: async ({ to }) => { pullRequestOf(to.url) },
    put: async ({ context, from, to, title, by }) => {
      await linkSessionPullRequest(from.sessionId, { url: pullRequestOf(to.url).url, title, source: context.actingAgent ? 'agent' : 'manual', by })
    },
    delete: async ({ from, to }) => {
      const identity = pullRequestOf(to.url)
      await unlinkSessionPullRequest(from.sessionId, identity.repository, identity.number)
    },
  },
}

/** The rule of one (from, to) pair, or a refusal for a pair that is not a link. */
function ruleOf<From>(rules: { [K in TargetKind]?: LinkRule<From, K> }, fromKind: 'task' | 'session', kind: TargetKind): LinkRule<From, TargetKind> {
  const rule = rules[kind]
  if (!rule) throw new SolusApiError(400, 'INVALID_REQUEST', `A ${fromKind} cannot link a ${kind}.`)
  // SAFETY: the table is keyed by target kind, so the rule found for `kind` takes a target of that kind.
  return rule as LinkRule<From, TargetKind>
}

export class LinkApiOperations {
  constructor(private readonly shares: ShareManager) {}

  async put(context: WorkspaceRequestContext, input: WorkspaceLink): Promise<void> {
    input = workspaceLinkSchema.parse(input)
    await this.apply(context, input, 'put')
  }

  async delete(context: WorkspaceRequestContext, input: WorkspaceLinkDelete): Promise<void> {
    input = workspaceLinkDeleteSchema.parse(input)
    await this.apply(context, input, 'delete')
  }

  /** The checks every pair shares, then the pair's own check and write. A delete checks `from` alone: its target may be gone. */
  private async apply(context: WorkspaceRequestContext, input: WorkspaceLink, verb: 'put' | 'delete'): Promise<void> {
    const { from, to } = input
    requireScope(context, from.kind === 'task' ? 'tasks:write' : 'sessions:write')
    await requireResource(this.shares, context, from, 'edit')
    if (input.originSessionId) await requireResource(this.shares, context, { kind: 'session', id: input.originSessionId }, 'edit')
    const by = writerAttribution(context, input.originSessionId ?? (from.kind === 'session' ? from.id : undefined))
    const shared = { context, shares: this.shares, to, title: input.title, role: input.role, originSessionId: input.originSessionId, by }
    if (from.kind === 'task') {
      const task = await Task.byId(apiScope(context), from.id).catch(() => null)
      if (!task) throw new SolusApiError(404, 'NOT_FOUND', 'Resource not found.')
      const rule = ruleOf<Task>(TASK_RULES, 'task', to.kind)
      const request = { ...shared, from: task, organizationId: task.record().organizationId ?? 'local' }
      if (verb === 'put') await rule.check(request)
      await rule[verb](request)
      return
    }
    const session = await getSessionRecord(apiScope(context), from.id)
    if (!session) throw new SolusApiError(404, 'NOT_FOUND', 'Resource not found.')
    const rule = ruleOf<SessionRecord>(SESSION_RULES, 'session', to.kind)
    const request = { ...shared, from: session, organizationId: session.organizationId }
    if (verb === 'put') await rule.check(request)
    await rule[verb](request)
  }
}
