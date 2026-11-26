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
import { roleAllows } from '@solus/contracts/permissions'
import { authorize } from '../../../admission/access-policy'
import { ANY_ORGANIZATION, type Principal } from '../../../admission/principal'
import { assertPathInScope } from '../../../data/sessions/guest-path-scope'
import { readStoredRegistration } from '../../../host/host-registration'
import { resolveHomePath } from '../../../platform/paths'
import { workspaceToolContext } from '../../../data/workspace/tool-context'
import { loadAutomation } from '../../../data/automations/automations-store'
import { linkSessionItem, unlinkSessionItem } from '../../../data/sessions/session-links'
import { readOwnSessionArtifacts } from '../../../data/sessions/session-artifacts'
import { linkedAppNamed } from './app-tools'
import type { WorkspaceLinkTarget } from '@solus/contracts/solus-api'
import { toolAgentAttribution } from './agent-attribution'

type ToolHome = Awaited<ReturnType<typeof workspaceToolContext>>

/**
 * Link a work, file, or automation to the calling session through the home's
 * link operation, which checks access and writes the edge, on this host or on
 * an organization's Solus API. The tool only names the target as the agent
 * sees it.
 */
export async function linkCallerItem(ctx: SessionLinkCtx, input: { kind: 'work' | 'automation' | 'file'; target_id?: string; path?: string; title?: string }): Promise<AgentToolResult> {
  const sessionId = ctx.sessionId
  if (!sessionId) return { ok: false, text: 'link needs a calling session id.' }
  const home = await workspaceToolContext(sessionId)
  let to: WorkspaceLinkTarget
  let title = input.title
  if (input.kind === 'work') {
    to = { kind: 'work', id: input.target_id?.trim() ?? '' }
  } else if (input.kind === 'file') {
    to = await fileTarget(ctx.cwd, input.path, await executionHostId(home, sessionId), home.context.principal)
    title ??= basename(to.path)
  } else {
    to = { kind: 'automation', id: input.target_id?.trim() ?? '', hostId: await executionHostId(home, sessionId) }
    title ??= (await loadAutomation(to.id))?.name
  }
  await home.operations.putLink(home.context, { from: { kind: 'session', id: sessionId }, to, title })
  return { ok: true, text: `Linked ${input.kind} to this session.` }
}

/** The host that runs the session, and so holds its files, automations, and apps: this host. */
async function executionHostId(home: ToolHome, sessionId: string): Promise<string> {
  if (home.context.home.kind === 'local') return home.context.home.hostId
  const hostId = readStoredRegistration()?.hostId ?? (await home.operations.getSession(home.context, sessionId)).runnerHostId
  if (!hostId) throw new Error('The execution host has no id yet.')
  return hostId
}

/** A file as the agent names it, relative to its working directory, and readable by the caller. */
async function fileTarget(cwd: string, named: string | undefined, hostId: string, principal: Principal): Promise<Extract<WorkspaceLinkTarget, { kind: 'file' }>> {
  if (!named?.trim()) throw new Error('link with kind=file requires path.')
  if (await authorize(principal, 'host.files.read', null, { name: 'link' })) throw new Error('File access is not available.')
  const path = await realpath(resolve(resolveHomePath(cwd), resolveHomePath(named.trim())))
  assertPathInScope('readProjectFile', principal, path)
  if (!(await stat(path)).isFile()) throw new Error('The target must be a file.')
  return { kind: 'file', path, hostId }
}

/**
 * Links or unlinks an app and the calling session (docs/plans/apps.md decision
 * 18). An app is on the host that runs it, and the edge is written there: the
 * organization's Solus API holds no app links yet, so an organization session
 * is refused.
 */
async function changeCallerAppLink(ctx: SessionLinkCtx, change: 'link' | 'unlink', input: { target_id?: string; title?: string }): Promise<AgentToolResult> {
  const sessionId = ctx.sessionId
  if (!sessionId) return { ok: false, text: `${change} needs a calling session id.` }
  const home = await workspaceToolContext(sessionId)
  if (home.remote) return { ok: false, text: 'An app cannot be linked to an organization session yet.' }
  const session = await home.operations.getSession(home.context, sessionId)
  if (!roleAllows(session.role, 'edit')) return { ok: false, text: 'This session cannot be edited.' }
  const app = await linkedAppNamed(input.target_id?.trim() ?? '')
  const target = { kind: 'app' as const, targetId: app.id, hostId: await executionHostId(home, sessionId) }
  if (change === 'unlink') {
    await unlinkSessionItem(sessionId, target)
    return { ok: true, text: 'Removed app link from this session.' }
  }
  await linkSessionItem(sessionId, { target, title: input.title ?? app.name }, await toolAgentAttribution(ctx))
  return { ok: true, text: 'Linked app to this session.' }
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
 * Link a pull request to the calling session through the home's link
 * operation. The machine that runs the session always holds the link, because
 * its PR sync watches the pull request: for an organization session, whose home
 * is the organization's Solus API, this host writes its own row as well.
 */
async function putSessionPullRequest(
  home: ToolHome, sessionId: string, url: string, title: string | undefined, ctx: SessionLinkCtx, source: 'agent' | 'created' = 'agent',
): Promise<void> {
  if (home.remote && source === 'agent') await linkSessionPullRequest(sessionId, { url, title, source, by: await toolAgentAttribution(ctx) })
  await home.operations.putLink(home.context, { from: { kind: 'session', id: sessionId }, to: { kind: 'pr', url }, title })
  // The workspace operation above admits the mutation. The execution host
  // can now record that the agent opened this PR, including for a remote home.
  if (source === 'created') await linkSessionPullRequest(sessionId, { url, title, source, by: await toolAgentAttribution(ctx) })
}

/** Link the pull request an agent names by number or URL. */
export async function linkCallerPullRequest(
  ctx: SessionLinkCtx,
  toolContext: () => ReturnType<typeof workspaceToolContext>,
  projectKey: string,
  input: { target_id?: string; title?: string },
  source: 'agent' | 'created' = 'agent',
): Promise<AgentToolResult> {
  // Durable rows of a session are keyed by Solus's session id.
  const callerSessionId = ctx.sessionId
  if (!callerSessionId) return { ok: false, text: 'link with kind=pr needs a calling session, and this session has no id yet.' }
  const named = input.target_id?.trim() ?? ''
  const identity = await namedPullRequest(projectKey, named)
  if (!identity) return { ok: false, text: `link could not find pull request "${named}". Pass its number or URL as target_id.` }
  await putSessionPullRequest(await toolContext(), callerSessionId, identity.url, input.title, ctx, source)
  return { ok: true, text: `Linked pull request #${identity.number} (${identity.repository}) to this session.` }
}

/**
 * Link several pull requests to the calling session in one call, such as the
 * layers of a stack. A pull request the session already shows is not linked
 * again, and a name that is not a pull request does not stop the others.
 */
export async function linkCallerPullRequests(
  ctx: SessionLinkCtx,
  toolContext: () => ReturnType<typeof workspaceToolContext>,
  projectKey: string,
  named: readonly string[],
): Promise<AgentToolResult> {
  const sessionId = ctx.sessionId
  if (!sessionId) return { ok: false, text: 'link with kind=pr needs a calling session, and this session has no id yet.' }
  const home = await toolContext()
  const shown = new Set((await home.operations.listSessionPullRequests(home.context, sessionId)).items.map(link => pullRequestKey(link)))
  const linked: PullRequestIdentity[] = []
  const alreadyLinked: PullRequestIdentity[] = []
  const invalid: string[] = []
  for (const name of named) {
    const identity = await namedPullRequest(projectKey, name)
    if (!identity) { invalid.push(name.trim()); continue }
    const key = pullRequestKey(identity)
    if (shown.has(key)) { alreadyLinked.push(identity); continue }
    shown.add(key)
    await putSessionPullRequest(home, sessionId, identity.url, undefined, ctx)
    linked.push(identity)
  }
  const lines = [`Linked ${countOf(linked.length, 'pull request')} to this session.`]
  if (linked.length) lines.push(`linked: ${byRepository(linked)}`)
  if (alreadyLinked.length) lines.push(`already linked: ${byRepository(alreadyLinked)}`)
  if (invalid.length) lines.push(`invalid (not a pull request number or URL): ${invalid.map(name => JSON.stringify(name)).join(', ')}`)
  return { ok: invalid.length < named.length, text: lines.join('\n') }
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
  await removeSessionPullRequest(await toolContext(), sessionId, identity)
  return { ok: true, text: `Removed pull request #${identity.number} (${identity.repository}) from this session.` }
}

const PULL_REQUEST_STATES = ['open', 'closed', 'merged'] as const
type PullRequestState = (typeof PULL_REQUEST_STATES)[number]

/**
 * Remove every pull request of the calling session whose state, as PR sync
 * last saw it, is one of `states`. A draft is open. A link that PR sync has
 * not answered for, or that the code host says is gone, has no known state
 * and stays.
 */
export async function unlinkCallerPullRequestsInStates(
  ctx: SessionLinkCtx,
  toolContext: () => ReturnType<typeof workspaceToolContext>,
  states: readonly PullRequestState[],
): Promise<AgentToolResult> {
  const sessionId = ctx.sessionId
  if (!sessionId) return { ok: false, text: 'unlink with kind=pr needs a calling session, and this session has no id yet.' }
  const home = await toolContext()
  const links = (await home.operations.listSessionPullRequests(home.context, sessionId)).items
  const removed = new Map<PullRequestState, PullRequestIdentity[]>()
  let unknown = 0
  for (const link of links) {
    const state = link.missing ? null : link.snapshot?.state ?? null
    if (!state) unknown++
    if (!state || !states.includes(state)) continue
    await removeSessionPullRequest(home, sessionId, link)
    const inState = removed.get(state)
    if (inState) inState.push(link)
    else removed.set(state, [link])
  }
  const count = [...removed.values()].reduce((total, identities) => total + identities.length, 0)
  const lines = [`Removed ${countOf(count, 'pull request')} in state ${states.join(' or ')} from this session.`]
  for (const state of PULL_REQUEST_STATES) {
    const identities = removed.get(state)
    if (identities) lines.push(`${state}: ${byRepository(identities)}`)
  }
  lines.push(`${countOf(links.length - count, 'pull request')} stay linked${unknown ? `, ${unknown} with no synced state` : ''}.`)
  return { ok: true, text: lines.join('\n') }
}

/** The home checks edit access before the execution host changes its PR watch. */
async function removeSessionPullRequest(home: Awaited<ReturnType<typeof workspaceToolContext>>, sessionId: string, identity: PullRequestIdentity): Promise<void> {
  await home.operations.deleteLink(home.context, { from: { kind: 'session', id: sessionId }, to: { kind: 'pr', url: identity.url } })
  if (home.remote) await unlinkSessionPullRequest(sessionId, identity.repository, identity.number)
}

type PullRequestIdentity = { repository: string; number: number; url: string }

function pullRequestKey(identity: Pick<PullRequestIdentity, 'repository' | 'number'>): string {
  return `${identity.repository.toLowerCase()}#${identity.number}`
}

/** "github.com/acme/app #3, #2; github.com/acme/web #9" */
function byRepository(identities: readonly PullRequestIdentity[]): string {
  const numbers = new Map<string, number[]>()
  for (const { repository, number } of identities) {
    const list = numbers.get(repository)
    if (list) list.push(number)
    else numbers.set(repository, [number])
  }
  return [...numbers].map(([repository, list]) => `${repository} ${list.map(number => `#${number}`).join(', ')}`).join('; ')
}

/** A task the calling session works on. The link is the task's, so the task
 *  page lists the session; it is written where the session's records live. */
async function changeCallerTaskLink(ctx: SessionLinkCtx, verb: 'link' | 'unlink', issueKey: string): Promise<AgentToolResult> {
  const sessionId = ctx.sessionId
  if (!sessionId) return { ok: false, text: `${verb} needs a calling session id.` }
  const home = await workspaceToolContext(sessionId)
  const from = { kind: 'issue' as const, id: issueKey.trim() }
  const to = { kind: 'session' as const, id: sessionId }
  if (verb === 'link') {
    await home.operations.putLink(home.context, { from, to, role: 'working', originSessionId: sessionId })
    return { ok: true, text: `Linked this session to issue ${from.id}.` }
  }
  await home.operations.deleteLink(home.context, { from, to })
  return { ok: true, text: `Removed this session from issue ${from.id}.` }
}

function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

const listLinkKind = z.enum(['work', 'automation', 'pr', 'file', 'app', 'issue'])

/** List only the calling session's links, from the home that owns them. */
async function listCallerLinks(ctx: SessionLinkCtx, kind?: z.infer<typeof listLinkKind>): Promise<AgentToolResult> {
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
    if (target.kind === 'issue') return `- issue: ${target.id}`
    return ''
  })
  // An app link is on this host alone, so it is read here and not through the home's link list.
  if (!kind || kind === 'app') {
    for (const item of await readOwnSessionArtifacts(ANY_ORGANIZATION, ctx.sessionId)) {
      if (item.kind === 'app') lines.push(`- app: ${item.appId} — ${item.title}`)
    }
  }
  return { ok: true, text: lines.length ? `Links for this session:\n${lines.join('\n')}` : 'No matching links for this session.' }
}

export interface SessionLinkCtx {
  cwd: string
  sessionId?: string
  agentProvider?: AgentId
}

const LINK_DESC =
  "Link an item to this session. Files and images use kind=file and path; others use target_id. Use kind=issue with the issue key when this session works on a GitHub, Jira or Linear issue. Link each PR you create or work on immediately. For several PRs, such as a stack or a pasted list, pass them all as target_ids in one call; use target_id for one PR. Solus updates PR state and settles the session when its PRs end. Repeated links are safe."
const UNLINK_DESC =
  "Remove a link from this session, keeping the target. Uses the same inputs as link. To remove every PR in some states, such as all closed or merged PRs, pass kind=pr and states in one call; use target_id for one PR. Removed PRs stay excluded from automatic linking until explicitly linked again. Missing files use their saved path from list_links."
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
  kind: z.enum(['work', 'automation', 'pr', 'file', 'app', 'issue']).describe('The item to link to this session. Use file for plan files.'),
  target_id: z.string().min(1).optional().describe('The work or automation id, an app\'s slug or id, a pull request number or URL, or an issue key. Required except for files and target_ids.'),
  target_ids: z.array(z.string().min(1)).min(1).max(200).optional().describe('For kind=pr: several pull request numbers or URLs to link in one call.'),
  path: z.string().min(1).optional().describe('For files: an absolute path on the execution host, or a path relative to this session’s working directory.'),
  title: z.string().optional().describe('Optional label; resolved from the target when omitted.'),
}, true, async (input, ctx) => {
  if (input.target_ids) {
    if (input.kind !== 'pr') return { ok: false, text: 'link accepts target_ids only for kind=pr.' }
    if (input.target_id) return { ok: false, text: 'Pass target_id for one pull request or target_ids for several, not both.' }
    return linkCallerPullRequests(ctx, () => workspaceToolContext(ctx.sessionId), await resolveRepoRoot(ctx.cwd) ?? ctx.cwd, input.target_ids)
  }
  if (input.kind !== 'file' && !input.target_id?.trim()) return { ok: false, text: `link requires target_id for kind=${input.kind}.` }
  if (input.kind === 'pr') {
    return linkCallerPullRequest(ctx, () => workspaceToolContext(ctx.sessionId), await resolveRepoRoot(ctx.cwd) ?? ctx.cwd, input)
  }
  if (input.kind === 'app') return changeCallerAppLink(ctx, 'link', input)
  if (input.kind === 'issue') return changeCallerTaskLink(ctx, 'link', input.target_id!)
  return linkCallerItem(ctx, { ...input, kind: input.kind })
})

export const listLinksAgentTool = sessionLinkTool('list_links', LIST_LINKS_DESC, {
  kind: listLinkKind.optional().describe('Omit to list all kinds.'),
}, false, async (input, ctx) => listCallerLinks(ctx, input.kind))

export const unlinkAgentTool = sessionLinkTool('unlink', UNLINK_DESC, {
  kind: z.enum(['work', 'automation', 'pr', 'file', 'app', 'issue']).describe('Link kind.'),
  target_id: z.string().min(1).optional().describe('The work or automation id, an app\'s slug or id, a PR number or URL, or an issue key. Required except for files and states.'),
  states: z.array(z.enum(PULL_REQUEST_STATES)).min(1).optional().describe('For kind=pr without target_id: remove every linked PR whose last synced state is one of these. PRs with no synced state stay.'),
  path: z.string().min(1).optional().describe('Linked file path, absolute or relative to this session’s directory.'),
}, true, async (input, ctx) => {
  if (!ctx.sessionId) return { ok: false, text: 'unlink needs a calling session id.' }
  if (input.states) {
    if (input.kind !== 'pr') return { ok: false, text: 'unlink accepts states only for kind=pr.' }
    if (input.target_id) return { ok: false, text: 'Pass target_id for one pull request or states for every pull request in those states, not both.' }
    return unlinkCallerPullRequestsInStates(ctx, () => workspaceToolContext(ctx.sessionId), input.states)
  }
  if (input.kind !== 'file' && !input.target_id?.trim()) return { ok: false, text: `unlink requires target_id for kind=${input.kind}.` }
  if (input.kind === 'app') return changeCallerAppLink(ctx, 'unlink', input)
  if (input.kind === 'issue') return changeCallerTaskLink(ctx, 'unlink', input.target_id!)
  const home = await workspaceToolContext(ctx.sessionId)
  if (input.kind === 'pr') {
    return unlinkCallerPullRequest(ctx, async () => home, await resolveRepoRoot(ctx.cwd) ?? ctx.cwd, { target_id: input.target_id! })
  }
  let target: WorkspaceLinkTarget
  if (input.kind === 'work') {
    target = { kind: 'work', id: input.target_id!.trim() }
  } else {
    const hostId = await executionHostId(home, ctx.sessionId)
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
