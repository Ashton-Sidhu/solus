import { realpath, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type { SessionLinkInput } from '@solus/contracts/session-links'
import { roleAllows } from '@solus/contracts/permissions'
import { authorize } from '../../../admission/access-policy'
import { actorFor } from '../../../admission/actor'
import { roleOf } from '../../../admission/access'
import { workspaceToolAuthority } from '../../../admission/workspace-tool-authority'
import { INTERNAL_PRINCIPAL } from '../../../admission/principal'
import { assertPathInScope } from '../../../data/sessions/guest-path-scope'
import { readStoredRegistration } from '../../../host/host-registration'
import { resolveHomePath } from '../../../platform/paths'
import { workspaceToolContext } from '../../../data/workspace/tool-context'
import { automationHomeOf, loadAutomation } from '../../../data/automations/automations-store'
import { linkSessionItem } from '../../../data/sessions/session-links'
import { recordOutboxOp } from '../../../sync/outbox/outbox-store'
import { toolAgentAttribution } from './agent-attribution'
import type { TaskToolCtx, TaskToolResult } from './task-tools'

/** Extend the existing link tool; remote writes use the same delivery path as session PR links. */
export async function linkCallerItem(ctx: TaskToolCtx, input: { kind: 'work' | 'automation' | 'file'; target_id?: string; path?: string; title?: string }): Promise<TaskToolResult> {
  const sessionId = ctx.sessionId
  if (!sessionId) return { ok: false, text: 'link needs a calling session id.' }
  const home = await workspaceToolContext(sessionId)
  const session = await home.operations.getSession(home.context, sessionId)
  if (!roleAllows(session.role, 'edit')) return { ok: false, text: 'This session cannot be edited.' }
  const actor = await toolAgentAttribution(ctx)
  let link: SessionLinkInput
  if (input.kind === 'work') {
    const work = await home.operations.getWork(home.context, input.target_id?.trim() ?? '')
    if (!roleAllows(work.role, 'edit')) return { ok: false, text: 'This work cannot be linked.' }
    if (work.organizationId !== session.organizationId) return { ok: false, text: 'The work and session must belong to the same organization.' }
    link = { target: { kind: 'work', targetId: work.id }, title: input.title ?? work.title }
  } else {
    const hostId = home.context.home.kind === 'local' ? home.context.home.hostId : readStoredRegistration()?.hostId ?? session.runnerHostId
    if (!hostId) return { ok: false, text: 'The execution host has no id yet.' }
    link = input.kind === 'file'
      ? await fileLink(ctx.cwd, input.path, hostId, home.context.principal)
      : await automationLink(input.target_id, hostId, session.organizationId)
    link.title = input.title ?? link.title
  }
  if (home.remote && home.context.home.kind === 'organization') {
    recordOutboxOp({ domain: 'sessions', resourceId: sessionId, name: 'link-item', payload: { ...link, actor }, sessionId,
      destination: 'cloud', organizationId: home.context.home.organizationId, actorUserId: home.deliveryActor ?? '' })
    return { ok: true, text: `Link of ${input.kind} is queued for the session’s organization and appears with this machine’s next delivery.` }
  }
  await linkSessionItem(sessionId, link, actor)
  return { ok: true, text: `Linked ${input.kind} to this session.` }
}

async function fileLink(cwd: string, named: string | undefined, hostId: string, principal: import('../../../admission/principal').Principal): Promise<SessionLinkInput> {
  if (!named?.trim()) throw new Error('link with kind=file requires path.')
  if (await authorize(principal, 'host.files.read', null, { name: 'link' })) throw new Error('File access is not available.')
  const path = await realpath(resolve(resolveHomePath(cwd), resolveHomePath(named.trim())))
  assertPathInScope('readProjectFile', principal, path)
  if (!(await stat(path)).isFile()) throw new Error('The target must be a file.')
  return { target: { kind: 'file', path, hostId }, title: basename(path) }
}

async function automationLink(named: string | undefined, hostId: string, organizationId: string | null): Promise<SessionLinkInput> {
  const id = named?.trim()
  const owner = id ? automationHomeOf(id) : null
  const actor = actorFor(workspaceToolAuthority() ?? INTERNAL_PRINCIPAL)
  if (!id || !owner || !roleAllows(roleOf(actor, { kind: 'automation', id, ...owner, acl: [] }), 'read')) throw new Error('Automation not found.')
  const automation = await loadAutomation(id)
  if (!automation || automation.organizationId !== (organizationId ?? 'local')) throw new Error('Automation not found in the session’s organization.')
  return { target: { kind: 'automation', targetId: id, hostId }, title: automation.name }
}
