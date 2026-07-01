import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PluginCommand, PluginCommandsResult } from '../../../shared/types'
import { MemoryCache } from '../../../shared/cache'

export const PLUGIN_CMD_TTL = 5 * 60 * 1000
export const _pluginCmdCache = new MemoryCache<string, PluginCommandsResult>({ ttlMs: PLUGIN_CMD_TTL })

async function listClaudeSkillCommands(skillsPath: string): Promise<PluginCommand[]> {
  try {
    const entries = await readdir(skillsPath, { withFileTypes: true })
    const skillEntries = await Promise.all(entries.map(async (entry) => {
      if (entry.isDirectory()) return entry
      if (!entry.isSymbolicLink()) return null
      return (await stat(join(skillsPath, entry.name)).catch(() => null))?.isDirectory() ? entry : null
    }))
    return skillEntries
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null && !entry.name.includes('.'))
      .map((entry) => ({ name: entry.name, description: '', kind: 'skill' as const, path: join(skillsPath, entry.name, 'SKILL.md') }))
  } catch {
    return []
  }
}

async function resolveClaudeSkills(workingDirectory: string): Promise<PluginCommandsResult> {
  const globalSkillsPath = join(homedir(), '.claude', 'skills')
  const projectSkillsPath = join(workingDirectory, '.claude', 'skills')
  const [global, project] = await Promise.all([
    listClaudeSkillCommands(globalSkillsPath),
    listClaudeSkillCommands(projectSkillsPath),
  ])
  return { global, project }
}

async function resolveClaudeSlashPluginCommands(workingDirectory: string): Promise<PluginCommandsResult> {
  const registryPath = join(homedir(), '.claude', 'plugins', 'installed_plugins.json')
  let registry: { plugins: Record<string, Array<{ scope: string; projectPath?: string; installPath: string }>> }
  try {
    registry = JSON.parse(await readFile(registryPath, 'utf-8'))
  } catch {
    return { global: [], project: [] }
  }

  const global: PluginCommand[] = []
  const project: PluginCommand[] = []

  for (const records of Object.values(registry.plugins)) {
    for (const record of records) {
      const isGlobal = record.scope === 'user'
      const isProject = record.scope === 'project' && record.projectPath === workingDirectory
      if (!isGlobal && !isProject) continue

      let files: string[]
      try {
        files = (await readdir(join(record.installPath, 'commands'))).filter(f => f.endsWith('.md'))
      } catch {
        continue
      }

      const target = isGlobal ? global : project
      for (const file of files) {
        const name = file.replace(/\.md$/, '')
        if (target.some(c => c.name === name)) continue
        const content = await readFile(join(record.installPath, 'commands', file), 'utf-8').catch(() => '')
        const description = content.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? ''
        const argumentHint = content.match(/^argument-hint:\s*["']?(.+?)["']?\s*$/m)?.[1]
        target.push({ name, description, argumentHint })
      }
    }
  }

  return { global, project }
}

function mergeCommands(primary: PluginCommand[], secondary: PluginCommand[]): PluginCommand[] {
  const seen = new Set(primary.map((command) => command.name))
  const merged = [...primary]
  for (const command of secondary) {
    if (seen.has(command.name)) continue
    seen.add(command.name)
    merged.push(command)
  }
  return merged
}

export async function resolvePluginCommands(workingDirectory: string): Promise<PluginCommandsResult> {
  const [skills, pluginCommands] = await Promise.all([
    resolveClaudeSkills(workingDirectory),
    resolveClaudeSlashPluginCommands(workingDirectory),
  ])
  return {
    global: mergeCommands(skills.global, pluginCommands.global),
    project: mergeCommands(skills.project, pluginCommands.project),
  }
}
