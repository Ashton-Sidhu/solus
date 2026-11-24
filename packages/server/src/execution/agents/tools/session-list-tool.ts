import { z } from 'zod'
import { resolveHomePath } from '../../../platform/paths'
import { workspaceToolContext } from '../../../data/workspace/tool-context'
import type { WorkspaceSession } from '@solus/contracts/solus-api/schemas'
import type { AgentTool, AgentToolResult } from './agent-tool'
import { findSession, getSessionController, sessionLink } from './session-tools'

/**
 * `list_sessions`: the user's sessions, newest activity first, as the session
 * list shows them. `search_sessions` finds a session by its words; this tool
 * answers "what runs now" and "what did this session start" with no query.
 */

const MAX_LIST = 50

const DESCRIPTION =
  "List the user's sessions on this host, newest activity first, as the session list shows them. Omit project for the project of this session; all_projects=true lists every project. parent_session_id lists the sessions that session started. Each row gives the session id, status, provider, and model. Page with cursor=nextCursor. To find a session by its words, use search_sessions. In your reply, name a session as its link verbatim."

const fields = {
  project: z.string().optional().describe('A project path. Defaults to the project of this session.'),
  all_projects: z.boolean().default(false).describe('List the sessions of every project.'),
  parent_session_id: z.string().min(1).optional().describe('List the sessions that this session started, in any project.'),
  limit: z.number().int().min(1).optional().describe(`Max sessions, 1 to ${MAX_LIST}. Defaults to 20.`),
  cursor: z.string().min(1).optional().describe('nextCursor from the last page.'),
}
const inputSchema = z.object(fields)
type ListInput = z.output<typeof inputSchema>

export async function listSessions(input: ListInput, callerSessionId: string | undefined, callerCwd: string | undefined): Promise<AgentToolResult> {
  if (!callerSessionId) return { ok: false, text: 'list_sessions is unavailable before the calling session is initialized.' }
  const { operations, context } = await workspaceToolContext(callerSessionId)
  // A session's children are in any project; otherwise one project unless the caller asks for all.
  const projectPath = input.all_projects || input.parent_session_id ? undefined
    : resolveHomePath(input.project?.trim() || (await findSession(callerSessionId))?.projectPath || callerCwd || '~')
  const page = await operations.listSessions(context, {
    scope: 'list',
    order: 'activity',
    limit: Math.min(input.limit ?? 20, MAX_LIST),
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(projectPath ? { projectPath, includeWorktrees: 'true' as const } : {}),
    ...(input.parent_session_id ? { parentSessionId: input.parent_session_id } : {}),
  })
  const where = input.parent_session_id ? `started by session ${input.parent_session_id}` : projectPath ? `in ${projectPath}` : 'in every project'
  if (!page.items.length) return { ok: true, text: `No sessions ${where}.` }
  const rows = page.items.map((session) => sessionRow(session, callerSessionId))
  const next = page.nextCursor ? `\n\nnextCursor: ${page.nextCursor}` : ''
  return { ok: true, text: `Sessions ${where}, newest activity first:\n\n${rows.join('\n')}${next}` }
}

function sessionRow(session: WorkspaceSession, callerSessionId: string): string {
  // The live status names what a stored record cannot: a rate limit, a question that waits.
  const status = getSessionController()?.liveStatus(session.id) ?? session.status
  const title = session.customTitle?.trim() || session.title?.trim() || '(untitled)'
  const link = sessionLink({ provider: session.provider, sessionId: session.id, slug: session.slug, cwd: session.cwd ?? session.projectPath, serverId: undefined })
  const self = session.id === callerSessionId ? ' (this session)' : ''
  return `- ${link} ${title}${self} · ${status} · ${session.provider}${session.model ? ` · ${session.model}` : ''} · session id ${session.id} · updated ${session.updatedAt}`
}

export const listSessionsAgentTool: AgentTool<typeof fields> = {
  name: 'list_sessions',
  description: DESCRIPTION,
  inputFields: fields,
  requiresApproval: false,
  execute: async (args, context) => listSessions(inputSchema.parse(args), context.sessionId(), resolveHomePath(context.cwd)),
}
