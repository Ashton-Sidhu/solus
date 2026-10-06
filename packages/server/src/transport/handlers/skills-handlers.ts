import { appendFile } from 'fs/promises'
import path from 'path'
import type { SessionRuntime } from '../../execution/session-runtime'
import { searchSkills, installSkill, listInstalledSkills, removeSkill } from '../../skills/skills-provider'
import type { MemberSkillHomes } from '../../skills/skills-cli'
import type { SeatStore } from '../../execution/seats/seat-manager'
import { projectScopeOf } from '@solus/contracts/types'
import { expandHome } from '../../files/host-path'
import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import { createLogger } from '../../logger'
import type { HandlerCtx, SolusServer } from '../server'
import { seatFor } from '../../admission/actor'

const log = createLogger('main', 'skills-handlers')
const UPDATE_AGENT_FILES_COMMAND = '/update-agent-files'

/** Instruction files land in the session's folder. A new chat has none until it starts. */
function agentFilesDirectory(scope: string): string {
  if (!scope || scope === NEW_CHAT_DIRECTORY) throw new Error('Send a first prompt before you update agent files')
  return expandHome(scope)
}

async function appendInstructionFile(filePath: string, text: string): Promise<void> {
  await appendFile(filePath, `\n${text.endsWith('\n') ? text : `${text}\n`}`, 'utf-8')
}

/**
 * Whose global skills a call manages. An organization member's are their own,
 * in their seats, where their turns look for them; the host's own are the
 * owner's. A guest never reaches these methods.
 */
function memberSkillHomes(ctx: HandlerCtx, seats: SeatStore): MemberSkillHomes | undefined {
  if (ctx.principal.kind !== 'org-member') return undefined
  const seat = seatFor(ctx.actor)
  if (seat.kind !== 'user') return undefined
  return {
    claudeHome: seats.homeFor(seat, 'claude-code'),
    codexHome: seats.homeFor(seat, 'codex'),
  }
}

/** Registers the opt-in skills.sh registry handlers (Settings → Skills). */
export function registerSkillsHandlers(server: SolusServer, deps: { sessionRuntime: SessionRuntime; seats: SeatStore }): void {
  server.register('skillsList', (_args, ctx) => listInstalledSkills(memberSkillHomes(ctx, deps.seats)))

  server.register('skillsRemove', async ([name], ctx) => {
    const result = await removeSkill(name, memberSkillHomes(ctx, deps.seats))
    if (result.ok) await deps.sessionRuntime.history.refreshPluginCommands()
    return result
  })

  server.register('skillsSearch', (args) => {
    const [query] = args
    return searchSkills(query)
  })

  server.register('skillsInstall', async (args, ctx) => {
    const [id] = args
    // Always install into every active provider — the cross-provider opt-in goal.
    const agents = deps.sessionRuntime.getBackendIds()
    const result = await installSkill(id, agents, memberSkillHomes(ctx, deps.seats))
    if (result.ok) await deps.sessionRuntime.history.refreshPluginCommands()
    return result
  })

  server.register('updateAgentFiles', async (args) => {
    const [ctx, text] = args
    if (!text) return { success: false, err: 'No content provided' }

    const cwd = agentFilesDirectory(projectScopeOf(ctx.session))
    const targets = [path.join(cwd, 'AGENTS.md')]
    if (deps.sessionRuntime.getBackendIds().includes('claude-code')) {
      targets.push(path.join(cwd, 'CLAUDE.md'))
    }

    try {
      await Promise.all(targets.map((target) => appendInstructionFile(target, text)))
      log.info('agent_files_updated', { command: UPDATE_AGENT_FILES_COMMAND, fileCount: targets.length, cwd })
      return { success: true, files: targets }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('agent_files_update_failed', { command: UPDATE_AGENT_FILES_COMMAND, error: message })
      return { success: false, err: message }
    }
  })
}
