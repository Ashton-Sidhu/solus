import { z } from 'zod'
import type { AgentTool, AgentToolResult } from './agent-tool'
import type { AgentId } from '@solus/contracts/types'
import { resolveRepoRoot } from '../../../git/git-helpers'
import { pullRequestIdentityOf } from '@solus/contracts/session-pull-requests'
import { parseGitHubPullRequestUrl } from '@solus/contracts/providers'
import { linkSessionPullRequest, unlinkSessionPullRequest } from '../../../data/sessions/session-pull-requests'
import { resolvePullRequestUrl } from '../../../providers/pull-request-url'
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
import type { WorkspaceLinkTarget } from '@solus/contracts/solus-api'
import { toolAgentAttribution } from './agent-attribution'

/** Extend the existing link tool; an organization session's link is written on its Solus API. */
export async function linkCallerItem(ctx: SessionLinkCtx, input: { kind: 'work' | 'automation' | 'file'; target_id?: string; path?: string; title?: string }): Promise<AgentToolResult> {
  const sessionId = ctx.sessionId
  if (!sessionId) return { ok: false, text: 'link needs a calling session id.' }
  const home = await workspaceToolContext(sessionId)
  const session = await home.operations.getSession(home.context, sessionId)
  if (!roleAllows(session.role, 'edit')) return { ok: false, text: 'This session cannot be edited.' }
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
  if (home.remote) {
    await home.operations.putLink(home.context, { from: { kind: 'session', id: sessionId }, to: linkTarget(link.target), title: link.title })
    return { ok: true, text: `Linked ${input.kind} to this session.` }
  }
  await linkSessionItem(sessionId, link, await toolAgentAttribution(ctx))
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

/** A session item link as the Solus API's link route names it. */
function linkTarget(target: SessionLinkInput['target']): WorkspaceLinkTarget {
  if (target.kind === 'work') return { kind: 'work', id: target.targetId }
  if (target.kind === 'automation') return { kind: 'automation', id: target.targetId, hostId: target.hostId }
  return target
}

/** The pull request an agent names by number or URL, or null when the
 *  project's code host has none by that name. */
export async function namedPullRequest(projectKey: string, named: string): Promise<{ repository: string; number: number; url: string } | null> {
  const trimmed = named.trim()
  const number = Number(trimmed.replace(/^#/, ''))
  const url = parseGitHubPullRequestUrl(trimmed)?.url
    ?? (Number.isSafeInteger(number) && number > 0 ? await resolvePullRequestUrl(projectKey, number) : null)
  return url ? pullRequestIdentityOf(url) : null
}

/**
 * Link a pull request to the calling session. The machine that runs the
 * session always holds the link, because its PR sync watches the pull request.
 * For an organization session on an attached machine the organization's Solus
 * API holds the session too, so the same link is written there, as the person.
 */
export async function linkCallerPullRequest(
  ctx: SessionLinkCtx,
  toolContext: () => ReturnType<typeof workspaceToolContext>,
  projectKey: string,
  input: { target_id?: string; title?: string },
): Promise<AgentToolResult> {
  // Durable rows of a session are keyed by Solus's session id.
  const callerSessionId = ctx.sessionId
  if (!callerSessionId) return { ok: false, text: 'link with kind=pr needs a calling session, and this session has no id yet.' }
  const named = input.target_id?.trim() ?? ''
  const identity = await namedPullRequest(projectKey, named)
  if (!identity) return { ok: false, text: `link could not find pull request "${named}". Pass its number or URL as target_id.` }
  const sessionId = callerSessionId
  const actor = await toolAgentAttribution(ctx)
  await linkSessionPullRequest(sessionId, { url: identity.url, title: input.title, source: 'agent', by: actor })
  const { operations, context, remote } = await toolContext()
  if (remote) await operations.putLink(context, { from: { kind: 'session', id: sessionId }, to: { kind: 'pr', url: identity.url }, title: input.title })
  return { ok: true, text: `Linked pull request #${identity.number} (${identity.repository}) to this session.` }
}

/**
 * Remove a pull request from the calling session. The row stays as a
 * tombstone, so PR sync does not link it again. For an organization session
 * the Solus API holds the session too, so the link is removed there as well.
 */
export async function unlinkCallerPullRequest(
  ctx: SessionLinkCtx,
  toolContext: () => ReturnType<typeof workspaceToolContext>,
  projectKey: string,
  input: { target_id: string },
): Promise<AgentToolResult> {
  const sessionId = ctx.sessionId
  if (!sessionId) return { ok: false, text: 'unlink with kind=pr needs a calling session, and this session has no id yet.' }
  const named = input.target_id.trim()
  const identity = await namedPullRequest(projectKey, named)
  if (!identity) return { ok: false, text: `unlink with kind=pr could not find pull request "${named}". Pass its number or URL as target_id.` }
  const { operations, context, remote } = await toolContext()
  // The home checks edit access before the execution host changes its PR watch.
  await operations.deleteLink(context, { from: { kind: 'session', id: sessionId }, to: { kind: 'pr', url: identity.url } })
  if (remote) await unlinkSessionPullRequest(sessionId, identity.repository, identity.number)
  return { ok: true, text: `Removed pull request #${identity.number} (${identity.repository}) from this session.` }
}

/** List only the calling session's links, from the home that owns them. */
async function listCallerLinks(ctx: SessionLinkCtx, kind?: 'work' | 'automation' | 'pr' | 'file'): Promise<AgentToolResult> {
  if (!ctx.sessionId) return { ok: false, text: 'list_links needs a calling session id.' }
  const { operations, context } = await workspaceToolContext(ctx.sessionId)
  const { items } = await operations.listSessionLinks(context, ctx.sessionId)
  const lines = items.filter(item => !kind || item.target.kind === kind).map(item => {
    const { target } = item
    if (target.kind === 'pr') {
      const identity = pullRequestIdentityOf(target.url)
      return `- pr: #${identity?.number} ${identity?.repository} [${item.state}]${item.title ? ` "${item.title}"` : ''} — ${target.url} (linked by ${item.source})`
    }
    if (target.kind === 'file') return `- file: ${JSON.stringify(target.path)} — ${item.title}`
    if (target.kind === 'work' || target.kind === 'automation') return `- ${target.kind}: ${target.id} — ${item.title}`
    return ''
  })
  return { ok: true, text: lines.length ? `Links for this session:\n${lines.join('\n')}` : 'No matching links for this session.' }
}

export interface SessionLinkCtx {
  cwd: string
  sessionId?: string
  agentProvider?: AgentId
}

const LINK_DESC =
  "Link an item to this session. Files and images use kind=file and path; others use target_id. Link each PR you create or work on immediately. Solus updates PR state and settles the session when its PRs end. Repeated links are safe."
const UNLINK_DESC =
  "Remove a link from this session, keeping the target. Uses the same inputs as link. Removed PRs stay excluded from automatic linking until explicitly linked again. Missing files use their saved path from list_links."
const LIST_LINKS_DESC =
  "List this session's links, with IDs or paths and last known PR states. Before finishing PR work, use kind=pr and link missing PRs."

function sessionLinkTool<Fields extends NonNullable<AgentTool['inputFields']>>(
  name: string,
  description: string,
  inputFields: Fields,
  requiresApproval: boolean,
  run: (input: z.output<z.ZodObject<Fields>>, ctx: SessionLinkCtx) => Promise<AgentToolResult>,
): AgentTool {
  const schema = z.object(inputFields).strict()
  return {
    name, description, inputFields, requiresApproval, strictInput: true,
    execute: async (args, context) => {
      const parsed = schema.safeParse(args)
      if (!parsed.success) return { ok: false, text: `Invalid arguments for ${name}: ${z.prettifyError(parsed.error)}` }
      try {
        return await run(parsed.data, { cwd: resolveHomePath(context.cwd), sessionId: context.sessionId(), agentProvider: context.provider })
      } catch (error) {
        return { ok: false, text: `${name} failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }
}

export const linkAgentTool = sessionLinkTool('link', LINK_DESC, {
  kind: z.enum(['work', 'automation', 'pr', 'file']).describe('The item to link to this session. Use file for Markdown plan files.'),
  target_id: z.string().min(1).optional().describe('The work or automation id, or a pull request number or URL. Required except for files.'),
  path: z.string().min(1).optional().describe('For files: an absolute path on the execution host, or a path relative to this session’s working directory.'),
  title: z.string().optional().describe('Optional label; resolved from the target when omitted.'),
}, true, async (input, ctx) => {
  if (input.kind !== 'file' && !input.target_id?.trim()) return { ok: false, text: `link requires target_id for kind=${input.kind}.` }
  if (input.kind === 'pr') {
    return linkCallerPullRequest(ctx, () => workspaceToolContext(ctx.sessionId), await resolveRepoRoot(ctx.cwd) ?? ctx.cwd, input)
  }
  return linkCallerItem(ctx, { ...input, kind: input.kind })
})

export const listLinksAgentTool = sessionLinkTool('list_links', LIST_LINKS_DESC, {
  kind: z.enum(['work', 'automation', 'pr', 'file']).optional().describe('Omit to list all kinds.'),
}, false, async (input, ctx) => listCallerLinks(ctx, input.kind))

export const unlinkAgentTool = sessionLinkTool('unlink', UNLINK_DESC, {
  kind: z.enum(['work', 'automation', 'pr', 'file']).describe('Link kind.'),
  target_id: z.string().min(1).optional().describe('The work or automation id, or PR number or URL. Required except for files.'),
  path: z.string().min(1).optional().describe('Linked file path, absolute or relative to this session’s directory.'),
}, true, async (input, ctx) => {
  if (!ctx.sessionId) return { ok: false, text: 'unlink needs a calling session id.' }
  if (input.kind !== 'file' && !input.target_id?.trim()) return { ok: false, text: `unlink requires target_id for kind=${input.kind}.` }
  const home = await workspaceToolContext(ctx.sessionId)
  const session = await home.operations.getSession(home.context, ctx.sessionId)
  if (input.kind === 'pr') {
    return unlinkCallerPullRequest(ctx, async () => home, await resolveRepoRoot(ctx.cwd) ?? ctx.cwd, { target_id: input.target_id! })
  }
  let target: WorkspaceLinkTarget
  if (input.kind === 'work') {
    target = { kind: 'work', id: input.target_id!.trim() }
  } else {
    const hostId = home.context.home.kind === 'local' ? home.context.home.hostId : readStoredRegistration()?.hostId ?? session.runnerHostId
    if (!hostId) return { ok: false, text: 'The execution host has no id yet.' }
    if (input.kind === 'file') {
      if (!input.path?.trim()) return { ok: false, text: 'unlink with kind=file requires path.' }
      const resolved = resolve(resolveHomePath(ctx.cwd), resolveHomePath(input.path.trim()))
      // A removed file can still have a link. Its saved absolute path is sufficient.
      const path = await realpath(resolved).catch(() => resolved)
      target = { kind: 'file', path, hostId }
    } else {
      target = { kind: 'automation', id: input.target_id!.trim(), hostId }
    }
  }
  await home.operations.deleteLink(home.context, { from: { kind: 'session', id: ctx.sessionId }, to: target })
  return { ok: true, text: `Removed ${input.kind} link from this session.` }
})
