import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { SolusAPI } from '@solus/contracts/host-api'
import type { Principal } from '../../../admission/principal'
import { workspaceToolAuthority } from '../../../admission/workspace-tool-authority'
import { startsAtHome } from '../../../files/host-path'
import type { AgentTool } from './agent-tool'
import type { PersonRpcHost } from './person-rpc'

/** The admitted turn's caller, forwarded to the same RPC gate the clients use. */
export interface ProjectToolCaller {
  clientId: string
  principal: Principal
  abortSignal: AbortSignal
}

export interface ProjectToolHost {
  create(request: Parameters<SolusAPI['setupCreateProject']>[0], caller: ProjectToolCaller): ReturnType<SolusAPI['setupCreateProject']>
  clone(request: Parameters<SolusAPI['setupCloneProject']>[0], caller: ProjectToolCaller): ReturnType<SolusAPI['setupCloneProject']>
  /**
   * Make the new folder a folder of the calling session, and a root of its
   * codebase when `addToCodebase` is true and no root holds it
   * (docs/plans/codebases.md decision 11).
   */
  adopt(sessionId: string, path: string, addToCodebase: boolean): Promise<{ addedToCodebase: boolean }>
  /** The RPCs of a person's client that the project and codebase record tools send, through its gate. */
  rpc: PersonRpcHost
}

let host: ProjectToolHost | null = null

/** Bound to this host's project handlers at boot. */
export function setProjectToolHost(next: ProjectToolHost | null): void {
  host = next
}

/** The host the project tools act through; null before boot. */
export function projectToolHost(): ProjectToolHost | null {
  return host
}

const hostPath = z.string().trim().min(1)
  .refine((path) => isAbsolute(path) || startsAtHome(path), 'Use an absolute path or a path under ~ on the host.')
const addToCodebase = z.boolean().optional().describe('Default true: also add the folder to the codebase of this session.')
const createFields = {
  name: z.string().trim().min(1).describe('The project name; Solus makes a safe folder name from it.'),
  parent: hostPath.optional().describe('Parent folder on this host. Defaults to its projects folder.'),
  add_to_codebase: addToCodebase,
}
const cloneFields = {
  clone_url: z.string().trim().min(1).describe('HTTPS or SSH Git URL ending in .git. Uses this turn author\'s Git credentials.'),
  name: z.string().trim().min(1).optional().describe('Folder name. Defaults to the repository name.'),
  destination: hostPath.optional().describe('Destination on this host; it must be new or empty. Defaults under its projects folder.'),
  protocol: z.enum(['https', 'ssh']).optional().describe('Omit to use the host\'s normal SSH/HTTPS selection.'),
  add_to_codebase: addToCodebase,
}

/** Where the new folder is for the calling session, as fields of the tool result. */
interface SessionFolderResult {
  /** The calling session works in the new folder now. */
  sessionFolder: boolean
  addedToCodebase: boolean
  sessionFolderError?: string
}

async function adoptInSession(projectHost: ProjectToolHost, sessionId: string | undefined, path: string, addToCodebase: boolean): Promise<SessionFolderResult> {
  if (!sessionId) return { sessionFolder: false, addedToCodebase: false }
  try {
    return { sessionFolder: true, ...await projectHost.adopt(sessionId, path, addToCodebase) }
  } catch (error) {
    // The project exists. The agent can still call attach_folder for it.
    return { sessionFolder: false, addedToCodebase: false, sessionFolderError: error instanceof Error ? error.message : String(error) }
  }
}

export const createProjectAgentTool: AgentTool = {
  name: 'create_project',
  description: 'Create a new folder and Git repository on this host, and register it as a Solus project. Returns path and projectKey. An existing folder is refused. The new folder becomes a folder of this session: you can work there (Codex: a write there needs an approval until the next turn).',
  inputFields: createFields,
  strictInput: true,
  requiresApproval: true,
  execute: async (input, context) => {
    const parsed = z.object(createFields).strict().safeParse(input)
    if (!parsed.success) return { ok: false, text: z.prettifyError(parsed.error) }
    const principal = workspaceToolAuthority()
    if (!principal) return { ok: false, text: 'create_project requires an admitted Solus turn.' }
    if (!host) return { ok: false, text: 'Project creation is not available on this host.' }
    if (context.abortSignal.aborted) return { ok: false, text: 'Project creation was cancelled.' }
    try {
      const { add_to_codebase, ...request } = parsed.data
      const result = await host.create(request, { principal, clientId: `agent:${context.sessionId() ?? context.provider}`, abortSignal: context.abortSignal })
      return { ok: true, text: JSON.stringify({ ...result, ...await adoptInSession(host, context.sessionId(), result.path, add_to_codebase !== false) }) }
    } catch (error) {
      return { ok: false, text: error instanceof Error ? error.message : String(error) }
    }
  },
}

export const cloneProjectAgentTool: AgentTool = {
  name: 'clone_project',
  description: 'Clone a Git repository on this host and register it as a Solus project. Returns path, projectKey, and auth status. Uses the turn author\'s credentials. The clone becomes a folder of this session: you can work there (Codex: a write there needs an approval until the next turn).',
  inputFields: cloneFields,
  strictInput: true,
  requiresApproval: true,
  execute: async (input, context) => {
    const parsed = z.object(cloneFields).strict().safeParse(input)
    if (!parsed.success) return { ok: false, text: z.prettifyError(parsed.error) }
    const principal = workspaceToolAuthority()
    if (!principal) return { ok: false, text: 'clone_project requires an admitted Solus turn.' }
    if (!host) return { ok: false, text: 'Project cloning is not available on this host.' }
    if (context.abortSignal.aborted) return { ok: false, text: 'Project cloning was cancelled.' }
    try {
      const { clone_url, add_to_codebase, ...options } = parsed.data
      const result = await host.clone({ cloneUrl: clone_url, ...options }, { principal, clientId: `agent:${context.sessionId() ?? context.provider}`, abortSignal: context.abortSignal })
      return { ok: true, text: JSON.stringify({ ...result, ...await adoptInSession(host, context.sessionId(), result.path, add_to_codebase !== false) }) }
    } catch (error) {
      return { ok: false, text: error instanceof Error ? error.message : String(error) }
    }
  },
}
