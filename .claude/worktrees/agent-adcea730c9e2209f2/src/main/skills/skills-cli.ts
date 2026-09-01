/**
 * Searches the skills.sh registry and drives the CLI (`npx skills`) to install skills
 * across the user's active agent providers. This is the opt-in path surfaced in
 * Settings → Skills; it is independent of the bundled auto-installer in installer.ts.
 *
 * The registry API works without a user API key.
 * Provider ids (claude-code, codex, opencode) map 1:1 to the CLI's `-a` agent values.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { getCliEnv } from '../cli-env'
import { createLogger } from '../logger'
import type { AgentId, RemoteSkill, SkillInstallResult } from '../../shared/types'

const execFileAsync = promisify(execFile)
const log = createLogger('skills', 'skills-cli.ts')

// `npx -y skills <args>`. `-y` auto-confirms the one-time package fetch.
const NPX = 'npx'
const BASE_ARGS = ['-y', 'skills']
const CLI_TIMEOUT_MS = 120_000
const SEARCH_API = 'https://skills.sh/api/search'
const SEARCH_LIMIT = 20

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g

function formatInstalls(count: number): string | undefined {
  if (!count || count <= 0) return undefined
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return String(count)
}

/**
 * Searches the registry API directly.
 * Returns [] for blank queries, no matches, or request failure — never throws.
 */
export async function searchSkills(query: string): Promise<RemoteSkill[]> {
  const q = query.trim()
  if (!q) return []

  try {
    const url = new URL(SEARCH_API)
    url.searchParams.set('q', q)
    url.searchParams.set('limit', String(SEARCH_LIMIT))
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = (await response.json()) as {
      skills: Array<{ id: string; skillId: string; name: string; installs: number; source: string }>
    }
    return data.skills
      .sort((a, b) => (b.installs || 0) - (a.installs || 0))
      .map((skill) => ({
        id: `${skill.source}@${skill.skillId}`,
        name: skill.name,
        repo: skill.source,
        installs: formatInstalls(skill.installs),
        url: `https://skills.sh/${skill.id}`,
      }))
  } catch (err) {
    log.warn(`skills.sh search "${q}" failed: ${(err as Error).message}`)
    return []
  }
}

interface CliInstalledSkill {
  name?: string
}

/**
 * Returns the names of globally-installed skills via `skills list -g --json`.
 * Used to mark search results that are already installed. Never throws.
 */
export async function listInstalledSkillNames(): Promise<string[]> {
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync(NPX, [...BASE_ARGS, 'list', '-g', '--json'], {
      env: getCliEnv({ DISABLE_TELEMETRY: '1' }),
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    }))
  } catch (err) {
    log.warn(`skills list failed: ${(err as Error).message}`)
    return []
  }

  try {
    const parsed = JSON.parse(stdout.replace(ANSI, '')) as CliInstalledSkill[]
    return parsed.map((s) => s.name).filter((n): n is string => !!n)
  } catch {
    return []
  }
}

/**
 * Installs `id` globally into every active provider via
 * `skills add <id> -g -y -a <agent>...`. Returns which agents it targeted.
 */
export async function installSkill(id: string, agentIds: AgentId[]): Promise<SkillInstallResult> {
  if (!id.trim()) return { ok: false, agents: [], error: 'No skill specified' }
  if (agentIds.length === 0) return { ok: false, agents: [], error: 'No active agent providers' }

  const agentArgs = agentIds.flatMap((id) => ['-a', id])
  log.info(`Installing ${id} for [${agentIds.join(', ')}]`)

  try {
    await execFileAsync(NPX, [...BASE_ARGS, 'add', id, '-g', '-y', ...agentArgs], {
      env: getCliEnv({ DISABLE_TELEMETRY: '1' }),
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    })
    log.info(`Installed ${id}`)
    return { ok: true, agents: agentIds }
  } catch (err) {
    const msg = (err as Error).message
    log.error(`Failed to install ${id}: ${msg}`)
    return { ok: false, agents: agentIds, error: msg }
  }
}
