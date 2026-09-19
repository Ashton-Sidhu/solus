/**
 * Searches the skills.sh registry and drives the CLI (`npx skills`) to install skills
 * across the user's active agent providers. This is the opt-in path surfaced in
 * Settings → Skills; it is independent of the bundled auto-installer in installer.ts.
 *
 * The registry API works without a user API key.
 * Provider ids (claude-code, codex, opencode) map 1:1 to the CLI's `-a` agent values.
 */

import { execFile } from 'child_process'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { getCliEnv } from '../cli-env'
import { createLogger } from '../logger'
import { captureServerEvent } from '../analytics'
import type { AgentId, RemoteSkill, SkillInstallResult } from '@solus/contracts/types'
import { z } from 'zod'
import type { SkillListResult, SkillRemoveResult } from '@solus/contracts/skill-types'

const execFileAsync = promisify(execFile)
const log = createLogger('skills', 'skills-cli.ts')

// `npx -y skills <args>`. `-y` auto-confirms the one-time package fetch.
const NPX = 'npx'
const BASE_ARGS = ['-y', 'skills']
const CLI_TIMEOUT_MS = 120_000
const SEARCH_API = 'https://skills.sh/api/search'
const SEARCH_LIMIT = 20

/** Keep npm's project discovery out of the server's working directory. */
async function runGlobalSkills(args: string[]): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'solus-skills-'))
  try {
    const { stdout } = await execFileAsync(NPX, [...BASE_ARGS, ...args], {
      cwd,
      env: getCliEnv({ DISABLE_TELEMETRY: '1' }),
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    })
    return stdout
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g
const skillSearchSchema = z.object({
  skills: z.array(z.object({
    id: z.string(),
    skillId: z.string(),
    name: z.string(),
    installs: z.number(),
    source: z.string(),
  })),
})
const installedSkillSchema = z.array(z.object({
  name: z.string().min(1),
  path: z.string(),
  agents: z.array(z.string()),
  source: z.string().nullable().optional().transform((value) => value ?? null),
}))

// CLI options, paths, and control characters cannot identify one global skill.
// eslint-disable-next-line no-control-regex
const removableSkillName = z.string().min(1).max(255).regex(/^[^-\s/\\][^/\\\x00-\x1f]*$/).refine((name) => name !== '.' && name !== '..')

function errorMessage(error: Parameters<typeof String>[0]): string {
  return error instanceof Error ? error.message : String(error)
}

function formatInstalls(count: number): string | undefined {
  if (!count || count <= 0) return undefined
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return String(count)
}

/**
 * Searches the registry API directly.
 * Returns [] for blank queries or no matches. Request failures reach the inline error state.
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
    const data = skillSearchSchema.parse(await response.json())
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
    log.warn('skills_search_failed', { query: q, error: errorMessage(err) })
    throw new Error('Could not search skills.sh. Try again.')
  }
}

/** A failed list must not appear as an empty installation. */
export async function listInstalledSkills(): Promise<SkillListResult> {
  try {
    const stdout = await runGlobalSkills(['list', '-g', '--json'])
    const skills = installedSkillSchema.parse(JSON.parse(stdout.replace(ANSI, '')))
    return { ok: true, skills }
  } catch (err) {
    log.warn('skills_list_failed', { error: errorMessage(err) })
    return { ok: false, error: 'Could not load global skills. Try again.' }
  }
}

/** Remove only a listed global skill; never accept CLI flags or path arguments. */
export async function removeSkill(name: string): Promise<SkillRemoveResult> {
  const parsed = removableSkillName.safeParse(name)
  if (!parsed.success) return { ok: false, error: 'Invalid skill name.' }
  const installed = await listInstalledSkills()
  if (!installed.ok) return installed
  if (!installed.skills.some((skill) => skill.name === name)) {
    return { ok: false, error: 'This global skill is no longer installed. Refresh the list.' }
  }
  try {
    await runGlobalSkills(['remove', name, '-g', '-y'])
    // The CLI can report a partial failure with exit code zero. Verify the result.
    const remaining = await listInstalledSkills()
    if (!remaining.ok) return remaining
    if (remaining.skills.some((skill) => skill.name === name)) {
      return { ok: false, error: 'The skill could not be removed from every agent. Refresh the list and try again.' }
    }
    return { ok: true }
  } catch (err) {
    log.warn('skill_remove_failed', { skillName: name, error: errorMessage(err) })
    return { ok: false, error: 'Could not remove the global skill. Try again.' }
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
  log.info('skill_install_started', { skillId: id, agentIds })

  try {
    await runGlobalSkills(['add', id, '-g', '-y', ...agentArgs])
    log.info('skill_installed', { skillId: id })
    captureServerEvent('skill_installed', {})
    return { ok: true, agents: agentIds }
  } catch (err) {
    const msg = errorMessage(err)
    log.error('skill_install_failed', { skillId: id, error: msg })
    return { ok: false, agents: agentIds, error: msg }
  }
}
