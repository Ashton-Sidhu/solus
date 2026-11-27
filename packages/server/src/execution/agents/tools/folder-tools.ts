import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { AgentId } from '@solus/contracts/types'
import type { Actor } from '../../../admission/actor'
import { startsAtHome } from '../../../files/host-path'
import type { AttachOutcome, SessionFolders } from '../../sessions/session-folders'
import type { AgentTool } from './agent-tool'

/** Wired once the host boots (`boot-server.ts`). */
let sessionFolders: Pick<SessionFolders, 'requestAttach'> | null = null
/** Whom a session's turn acts for: the folder must be one that person may use. */
let actorOfSession: ((sessionId: string) => Actor) | null = null
export function setFolderToolHost(folders: Pick<SessionFolders, 'requestAttach'> | null, sessionActor: ((sessionId: string) => Actor) | null): void {
  sessionFolders = folders
  actorOfSession = sessionActor
}

const attachFolderFields = {
  path: z.string().trim().min(1)
    .refine((path) => isAbsolute(path) || startsAtHome(path), 'Use an absolute path or a path under ~ on this host.')
    .describe('A folder on this host, or a file in it: absolute, or under ~.'),
}

/** What an attach did, in words for the agent. */
export function attachOutcomeText(outcome: AttachOutcome, path: string, provider: AgentId): string {
  switch (outcome.kind) {
    case 'attached': {
      const codebase = outcome.addedToCodebase ? ' The folder is now in the codebase of this session.' : ''
      // Codex gets its writable folders at a turn start (docs/plans/codebases.md §6).
      const codex = provider === 'codex' ? ' You can read there now. A write there needs an approval in this turn, and none from the next turn.' : ''
      const antigravity = provider === 'antigravity' ? ' You can read files there now through Solus. Antigravity adds the folder to its workspace when a new prompt starts a turn.' : ''
      return `Attached "${outcome.folder}". This session can now work in that folder.${codebase}${codex}${antigravity}`
    }
    case 'available':
      return `"${path}" is already available: this session works in "${outcome.folder}".`
    case 'other-host':
      return `"${outcome.path}" is on the host "${outcome.host}", not on this host, so this session cannot work there. To change it, start a session on that host with start_sessions: host "${outcome.host}", cwd "${outcome.path}".`
    case 'refused':
      return `The person refused to attach "${outcome.folder}" to this session. Do not ask again in this turn. Continue without that folder.`
    case 'not-asked':
      return `"${outcome.folder}" was not attached: the person did not answer.`
    case 'invalid':
      return outcome.message
  }
}

export const attachFolderAgentTool: AgentTool = {
  name: 'attach_folder',
  description: 'Add a folder on this host to the folders THIS session works in. Call it before you read or change files outside the working directory and the folders of the session. A path in a Git repository attaches the root of that repository. Solus asks the person when the permission mode needs it.',
  inputFields: attachFolderFields,
  strictInput: true,
  // The attach rule decides if a person is asked (docs/plans/codebases.md decision 8), not the approval gate of the provider.
  requiresApproval: false,
  execute: async (rawInput, context) => {
    const parsed = z.object(attachFolderFields).strict().safeParse(rawInput)
    if (!parsed.success) return { ok: false, text: z.prettifyError(parsed.error) }
    const sessionId = context.sessionId()
    if (!sessionId) return { ok: false, text: 'attach_folder needs a Solus session.' }
    if (!sessionFolders || !actorOfSession) return { ok: false, text: 'Session folders are not available on this host.' }
    const outcome = await sessionFolders.requestAttach(sessionId, parsed.data.path, 'attached', actorOfSession(sessionId), {
      asker: { emit: context.emit, signal: context.abortSignal },
      byName: true,
    })
    return { ok: outcome.kind === 'attached' || outcome.kind === 'available', text: attachOutcomeText(outcome, parsed.data.path, context.provider) }
  },
}
