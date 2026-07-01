import { appendFile } from 'fs/promises'
import { homedir } from 'os'
import path from 'path'
import type { ControlPlane } from '../../control-plane'
import { searchSkills, installSkill } from '../../skills/skills-provider'
import { WORKSPACE_DIR } from '../../workspace'
import type { IpcContext } from '../../../shared/types'
import { createLogger } from '../../logger'
import type { SolusServer } from '../server'

const log = createLogger('main', 'skills-handlers')
const UPDATE_AGENT_FILES_COMMAND = '/update-agent-files'

function resolveWorkingDirectory(cwd: string): string {
  if (!cwd || cwd === '~') return WORKSPACE_DIR
  if (cwd.startsWith('~/')) return path.join(homedir(), cwd.slice(2))
  return cwd
}

async function appendInstructionFile(filePath: string, text: string): Promise<void> {
  await appendFile(filePath, `\n${text.endsWith('\n') ? text : `${text}\n`}`, 'utf-8')
}

/** Registers the opt-in skills.sh registry handlers (Settings → Skills). */
export function registerSkillsHandlers(server: SolusServer, deps: { controlPlane: ControlPlane }): void {
  server.register('skillsSearch', (args) => {
    const [query] = args as [string]
    return searchSkills(query)
  })

  server.register('skillsInstall', async (args) => {
    const [id] = args as [string]
    // Always install into every active provider — the cross-provider opt-in goal.
    const agents = deps.controlPlane.getBackendIds()
    const result = await installSkill(id, agents)
    if (result.ok) await deps.controlPlane.refreshPluginCommands()
    return result
  })

  server.register('updateAgentFiles', async (args) => {
    const [ctx, text] = args as [IpcContext, string]
    if (!text) return { success: false, err: 'No content provided' }

    const cwd = resolveWorkingDirectory(ctx.session.projectPath || ctx.session.workingDirectory)
    const targets = [path.join(cwd, 'AGENTS.md')]
    if (deps.controlPlane.getBackendIds().includes('claude-code')) {
      targets.push(path.join(cwd, 'CLAUDE.md'))
    }

    try {
      await Promise.all(targets.map((target) => appendInstructionFile(target, text)))
      log.info(`${UPDATE_AGENT_FILES_COMMAND}: wrote ${targets.length} file(s) in ${cwd}`)
      return { success: true, files: targets }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`${UPDATE_AGENT_FILES_COMMAND} failed: ${message}`)
      return { success: false, err: message }
    }
  })
}
