import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { AGENT_PROFILE_MAX_FILE_BYTES } from '@solus/contracts/agent-profile'
import { hostCliEnv, launchedProcess } from '../cli-env'
import { createLogger } from '../logger'

const log = createLogger('skills', 'registry-skill-cache.ts')

/** A skill folder deeper than this is not read. */
const MAX_DEPTH = 8
const DOWNLOAD_TIMEOUT_MS = 120_000
const execFileAsync = promisify(execFile)

/** One file of a registry skill, by its path inside the skill's folder. */
export interface RegistrySkillFile {
  path: string
  content: Buffer
  executable: boolean
}

/**
 * Registry skills as plain files (plans/020-agent-profile.md §2): each
 * `source@skillId` is downloaded once, as the server, into this host's data
 * folder, and read from there after. The agent profile writes the files into
 * each person's agent homes like any other profile file, so a registry skill
 * and a hand-written one end up in the same place. A file an agent profile
 * cannot hold (hidden, too large) is left out.
 */
export class RegistrySkillCache {
  private readonly downloads = new Map<string, Promise<string>>()

  constructor(
    private readonly root: string,
    private readonly download: (id: string, home: string) => Promise<void> = downloadSkill,
  ) {}

  async files(id: string, name: string): Promise<RegistrySkillFile[]> {
    const files: RegistrySkillFile[] = []
    readFolder(await this.folder(id, name), '', 0, files)
    return files
  }

  /** The skill's cached folder, downloaded the first time; one download per id at a time. */
  private folder(id: string, name: string): Promise<string> {
    const folder = join(this.root, createHash('sha256').update(id).digest('hex').slice(0, 24))
    if (existsSync(join(folder, 'SKILL.md'))) return Promise.resolve(folder)
    let pending = this.downloads.get(id)
    if (!pending) {
      pending = this.fetch(id, name, folder).finally(() => this.downloads.delete(id))
      this.downloads.set(id, pending)
    }
    return pending
  }

  private async fetch(id: string, name: string, folder: string): Promise<string> {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const home = await mkdtemp(join(this.root, '.download-'))
    try {
      await this.download(id, home)
      const skills = join(home, '.claude', 'skills')
      const downloaded = existsSync(join(skills, name, 'SKILL.md')) ? join(skills, name) : null
      if (!downloaded) throw new Error(`The skills CLI did not place "${name}".`)
      await rm(folder, { recursive: true, force: true })
      await rename(downloaded, folder)
      log.info('registry_skill_downloaded', { skillId: id })
      return folder
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }
}

/**
 * The skills CLI downloads one skill into `home`, as the server and never as a
 * person: `home/.claude/skills/<name>` holds plain files afterwards. Its store,
 * links, and agent folders stay in this temporary home.
 */
async function downloadSkill(id: string, home: string): Promise<void> {
  const env = hostCliEnv({ DISABLE_TELEMETRY: '1', HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), npm_config_cache: process.env.npm_config_cache ?? join(homedir(), '.npm') })
  const run = launchedProcess({ env }, 'npx', ['-y', 'skills', 'add', id, '-g', '-y', '--copy', '-a', 'claude-code'])
  await execFileAsync(run.file, run.args, { cwd: home, env: run.env, timeout: DOWNLOAD_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 })
}

function readFolder(folder: string, prefix: string, depth: number, files: RegistrySkillFile[]): void {
  if (depth >= MAX_DEPTH) return
  for (const name of readdirSync(folder).sort()) {
    if (name.startsWith('.') || name === 'node_modules') continue
    const absolute = join(folder, name)
    const path = prefix ? `${prefix}/${name}` : name
    const stats = statSync(absolute)
    if (stats.isDirectory()) readFolder(absolute, path, depth + 1, files)
    else if (stats.isFile() && stats.size <= AGENT_PROFILE_MAX_FILE_BYTES) files.push({ path, content: readFileSync(absolute), executable: (stats.mode & 0o111) !== 0 })
  }
}
