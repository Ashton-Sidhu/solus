import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { SolusAPI } from '@solus/contracts/host-api'
import type { Principal } from '../../../admission/principal'
import { workspaceToolAuthority } from '../../../admission/workspace-tool-authority'
import { startsAtHome } from '../../../files/host-path'
import type { AgentTool } from './agent-tool'

/** The admitted turn's caller, forwarded to the same RPC gate the clients use. */
export interface ProjectToolCaller {
  clientId: string
  principal: Principal
  abortSignal: AbortSignal
}

export interface ProjectToolHost {
  create(request: Parameters<SolusAPI['setupCreateProject']>[0], caller: ProjectToolCaller): ReturnType<SolusAPI['setupCreateProject']>
  clone(request: Parameters<SolusAPI['setupCloneProject']>[0], caller: ProjectToolCaller): ReturnType<SolusAPI['setupCloneProject']>
}

let host: ProjectToolHost | null = null

/** Bound to this host's project handlers at boot. */
export function setProjectToolHost(next: ProjectToolHost | null): void {
  host = next
}

const hostPath = z.string().trim().min(1)
  .refine((path) => isAbsolute(path) || startsAtHome(path), 'Use an absolute path or a path under ~ on the host.')
const createFields = {
  name: z.string().trim().min(1).describe('The project name; Solus makes a safe folder name from it.'),
  parent: hostPath.optional().describe('Parent folder on this host. Defaults to its projects folder.'),
}
const cloneFields = {
  clone_url: z.string().trim().min(1).describe('HTTPS or SSH Git URL ending in .git. Uses this turn author\'s Git credentials.'),
  name: z.string().trim().min(1).optional().describe('Folder name. Defaults to the repository name.'),
  destination: hostPath.optional().describe('Destination on this host; it must be new or empty. Defaults under its projects folder.'),
  protocol: z.enum(['https', 'ssh']).optional().describe('Omit to use the host\'s normal SSH/HTTPS selection.'),
}

export const createProjectAgentTool: AgentTool = {
  name: 'create_project',
  description: 'Create a new folder and Git repository on this host, and register it as a Solus project. Returns path and projectKey. An existing folder is refused. This does not move this session. To work there, pass the returned path as cwd to start_session.',
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
      const result = await host.create(parsed.data, { principal, clientId: `agent:${context.sessionId() ?? context.provider}`, abortSignal: context.abortSignal })
      return { ok: true, text: JSON.stringify(result) }
    } catch (error) {
      return { ok: false, text: error instanceof Error ? error.message : String(error) }
    }
  },
}

export const cloneProjectAgentTool: AgentTool = {
  name: 'clone_project',
  description: 'Clone a Git repository on this host and register it as a Solus project, using the same service as Add project. Returns path, projectKey, and auth status. Uses the turn author\'s credentials. Registration is included. This does not move this session. To work there, pass the returned path as cwd to start_session.',
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
      const { clone_url, ...options } = parsed.data
      const result = await host.clone({ cloneUrl: clone_url, ...options }, { principal, clientId: `agent:${context.sessionId() ?? context.provider}`, abortSignal: context.abortSignal })
      return { ok: true, text: JSON.stringify(result) }
    } catch (error) {
      return { ok: false, text: error instanceof Error ? error.message : String(error) }
    }
  },
}
