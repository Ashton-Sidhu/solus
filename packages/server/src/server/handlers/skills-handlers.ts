import { appendFile } from 'fs/promises'
import path from 'path'
import type { ControlPlane } from '../../control-plane'
import { searchSkills, installSkill, listInstalledSkills, removeSkill } from '../../skills/skills-provider'
import { projectScopeOf } from '@solus/contracts/types'
import { expandHome } from './lib/host-path'
import { resolveUnknownFolder } from './setup-handlers'
import { createLogger } from '../../logger'
import type { SolusServer } from '../server'
import type { Principal } from '../principal'

const log = createLogger('main', 'skills-handlers')
const UPDATE_AGENT_FILES_COMMAND = '/update-agent-files'

/** Instruction files need somewhere real to land, so a session with no project
 *  writes to the caller's chat folder rather than the host's home directory. */
function agentFilesDirectory(scope: string, principal: Principal): string {
  return expandHome(resolveUnknownFolder(scope || '~', principal))
}

async function appendInstructionFile(filePath: string, text: string): Promise<void> {
  await appendFile(filePath, `\n${text.endsWith('\n') ? text : `${text}\n`}`, 'utf-8')
}

/** Registers the opt-in skills.sh registry handlers (Settings → Skills). */
export function registerSkillsHandlers(server: SolusServer, deps: { controlPlane: ControlPlane }): void {
  server.register('skillsList', () => listInstalledSkills())

  server.register('skillsRemove', async ([name]) => {
    const result = await removeSkill(name)
    if (result.ok) await deps.controlPlane.refreshPluginCommands()
    return result
  })

  server.register('skillsSearch', (args) => {
    const [query] = args
    return searchSkills(query)
  })

  server.register('skillsInstall', async (args) => {
    const [id] = args
    // Always install into every active provider — the cross-provider opt-in goal.
    const agents = deps.controlPlane.getBackendIds()
    const result = await installSkill(id, agents)
    if (result.ok) await deps.controlPlane.refreshPluginCommands()
    return result
  })

  server.register('updateAgentFiles', async (args, handlerCtx) => {
    const [ctx, text] = args
    if (!text) return { success: false, err: 'No content provided' }

    const cwd = agentFilesDirectory(projectScopeOf(ctx.session), handlerCtx.principal)
    const targets = [path.join(cwd, 'AGENTS.md')]
    if (deps.controlPlane.getBackendIds().includes('claude-code')) {
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
