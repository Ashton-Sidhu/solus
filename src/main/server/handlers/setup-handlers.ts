import { execFileSync, spawn as nodeSpawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { homedir } from 'os'
import path, { basename, join } from 'path'
import { AGENT_BIN, type AgentId, type ServerCapabilities, type SetupAgent, type SetupAgentAuthCheckResult, type SetupGithubRepo, type SetupGithubReposResult, type SetupLogEvent, type SetupStatusEvent, type SetupStepResult, type SetupStreamStep } from '../../../shared/types'
import type { SolusServer, HandlerCtx } from '../server'
import { getCliEnv } from '../../cli-env'
import { listProjects, recordProject } from '../../project-config/projects-manifest'
import { resolveProjectKey } from '../../project-config/project-config'
import { loadToken as loadGithubToken } from '../../providers/github/token-store'
import { GitHubAuth } from '../../providers/github/auth'
import { buildClient } from '../../providers/github/octokit'
import { PARAKEET_MODEL_DIR } from '../../model-downloader'
import { WORKSPACE_DIR } from '../../workspace'
import { getServerSettings, setServerName } from '../settings'

const ANSI_RE = /\x1b\[[0-9;]*m/g
const MAX_SETUP_LOG_LINES = 1_000
const CLAUDE_NPM_PACKAGE = '@anthropic-ai/claude-code'
const CODEX_NPM_PACKAGE = '@openai/codex'
const CLAUDE_INSTALL_SCRIPT = 'curl -fsSL https://claude.ai/install.sh | bash -s'

export interface InstallCommandSpec {
  command: string
  args: string[]
  display: string
  strategy: 'npm' | 'claude-install-script'
}

interface ProcessCommandSpec {
  command: string
  args: string[]
  display: string
}

export interface BuildInstallCommandOptions {
  hasCommand?: (command: string) => boolean
}

export interface CloneUrlInfo {
  cloneUrl: string
  repoName: string
}

export type SpawnProcess = (
  command: string,
  args: string[],
  options: Parameters<typeof nodeSpawn>[2],
) => ChildProcess

export interface SetupHandlerDeps {
  spawnProcess?: SpawnProcess
  hasCommand?: (command: string) => boolean
}

export interface CapabilityProbeOptions {
  headless: boolean
  desktopHandlers: boolean
  version: string
}

export async function probeServerCapabilities(opts: CapabilityProbeOptions): Promise<ServerCapabilities> {
  const projects = await listProjects().catch(() => [])
  return {
    headless: opts.headless,
    desktopHandlers: opts.desktopHandlers,
    agents: {
      claude: !!resolveAgentBinary('claude-code'),
      codex: !!resolveAgentBinary('codex'),
    },
    dictation: existsSync(join(PARAKEET_MODEL_DIR, '.installed')),
    platform: process.platform,
    version: opts.version,
    projectCount: projects.length,
    agentAuth: {
      claude: hasClaudeAuth(),
    },
    gitAuth: {
      github: hasGithubAuth(),
    },
    serverName: getServerSettings().name,
  }
}

export function resolveAgentBinary(agentId: AgentId): string | null {
  const bin = AGENT_BIN[agentId]
  if (!bin) return null
  try {
    return execFileSync('which', [bin], { encoding: 'utf8', env: getCliEnv(), timeout: 3000 }).trim() || null
  } catch {
    return null
  }
}

export function hasClaudeAuth(): boolean {
  return existsSync(join(homedir(), '.claude.json')) ||
    existsSync(join(homedir(), '.claude', '.credentials.json')) ||
    existsSync(join(homedir(), '.config', 'claude', 'credentials.json'))
}

export function hasGithubAuth(): boolean {
  try {
    return !!loadGithubToken()
  } catch {
    return false
  }
}

export function coerceSetupAgent(value: unknown): SetupAgent {
  if (value === 'claude' || value === 'codex') return value
  throw new Error('Unsupported setup agent.')
}

/**
 * npm is the primary installer because both supported CLIs publish official npm
 * packages and the existing CLI env already discovers version-manager PATHs.
 * Claude keeps its official install-script fallback for hosts without npm.
 */
export function buildAgentInstallCommand(agent: SetupAgent, opts: BuildInstallCommandOptions = {}): InstallCommandSpec {
  const hasCommand = opts.hasCommand ?? commandExists
  if (agent === 'claude') {
    if (hasCommand('npm')) {
      return {
        command: 'npm',
        args: ['install', '-g', CLAUDE_NPM_PACKAGE],
        display: `npm install -g ${CLAUDE_NPM_PACKAGE}`,
        strategy: 'npm',
      }
    }
    return {
      command: 'bash',
      args: ['-lc', CLAUDE_INSTALL_SCRIPT],
      display: CLAUDE_INSTALL_SCRIPT,
      strategy: 'claude-install-script',
    }
  }

  if (!hasCommand('npm')) throw new Error('npm is required to install Codex CLI.')
  return {
    command: 'npm',
    args: ['install', '-g', CODEX_NPM_PACKAGE],
    display: `npm install -g ${CODEX_NPM_PACKAGE}`,
    strategy: 'npm',
  }
}

export function validateCloneUrl(raw: string): CloneUrlInfo {
  const cloneUrl = raw.trim()
  if (!cloneUrl) throw new Error('Clone URL is required.')
  if (cloneUrl.length > 2048 || /[\s\x00-\x1f\x7f]/.test(cloneUrl)) {
    throw new Error('Clone URL must not contain whitespace or control characters.')
  }

  const https = parseHttpsCloneUrl(cloneUrl)
  if (https) return https

  const sshUrl = parseSshCloneUrl(cloneUrl)
  if (sshUrl) return sshUrl

  const scpLike = parseScpLikeCloneUrl(cloneUrl)
  if (scpLike) return scpLike

  throw new Error('Clone URL must be a well-formed https or ssh git URL ending in .git.')
}

export function safeProjectDirName(raw: string): string {
  const base = raw.trim().replace(/\.git$/i, '')
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  if (!cleaned || /^\.+$/.test(cleaned)) return 'project'
  return cleaned.startsWith('.') ? `project-${cleaned.slice(1)}` : cleaned
}

export function setupProjectsRoot(): string {
  return join(WORKSPACE_DIR, 'projects')
}

export function registerSetupHandlers(server: SolusServer, deps: SetupHandlerDeps = {}): void {
  const spawnProcess = deps.spawnProcess ?? nodeSpawn
  const hasCommand = deps.hasCommand ?? commandExists
  let activeStep: SetupStreamStep | null = null

  const emitStatus = (event: SetupStatusEvent) => server.broadcast('setup-status', event)
  const emitLog = (event: SetupLogEvent) => server.broadcast('setup-log', event)

  server.register('setServerName', (args, ctx) => {
    requireAuthenticatedSetupContext(ctx)
    const [name] = args as [string]
    const next = setServerName(String(name ?? ''))
    return { name: next.name }
  })

  server.register('setupInstallAgentCli', async (args, ctx) => {
    requireAuthenticatedSetupContext(ctx)
    const [{ agent }] = args as [{ agent: unknown }]
    const setupAgent = coerceSetupAgent(agent)
    const step = installStepForAgent(setupAgent)

    return runExclusive(step, async () => {
      try {
        const spec = buildAgentInstallCommand(setupAgent, { hasCommand })
        emitLog({ step, line: `Running ${spec.display}` })
        return await runSetupProcess({ step, spec, spawnProcess, emitStatus, emitLog })
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        emitStatus({ step, status: 'failed', error })
        throw err
      }
    })
  })

  server.register('setupCheckAgentAuth', (args, ctx): SetupAgentAuthCheckResult => {
    requireAuthenticatedSetupContext(ctx)
    const [{ agent }] = args as [{ agent: unknown }]
    const setupAgent = coerceSetupAgent(agent)
    return checkAgentAuth(setupAgent)
  })

  server.register('setupListGithubRepos', async (_args, ctx): Promise<SetupGithubReposResult> => {
    requireAuthenticatedSetupContext(ctx)
    if (!hasGithubAuth()) return { connected: false }

    const client = await buildClient(new GitHubAuth())
    const res = await client.rest.repos.listForAuthenticatedUser({
      affiliation: 'owner,collaborator,organization_member',
      sort: 'updated',
      direction: 'desc',
      per_page: 50,
    })
    const repos: SetupGithubRepo[] = res.data.map((repo) => ({
      name: repo.name,
      fullName: repo.full_name,
      private: repo.private,
      cloneUrl: repo.clone_url,
      updatedAt: repo.updated_at ?? repo.pushed_at ?? '',
    }))
    return { connected: true, repos }
  })

  server.register('setupCloneProject', async (args, ctx) => {
    requireAuthenticatedSetupContext(ctx)
    const [{ cloneUrl, name }] = args as [{ cloneUrl: unknown; name?: unknown }]
    const parsed = validateCloneUrl(String(cloneUrl ?? ''))
    const projectName = safeProjectDirName(typeof name === 'string' && name.trim() ? name : parsed.repoName)
    const step: SetupStreamStep = 'clone'

    return runExclusive(step, async () => {
      const root = setupProjectsRoot()
      await mkdir(root, { recursive: true })
      const targetPath = uniqueProjectPath(root, projectName)
      const spec: ProcessCommandSpec = {
        command: 'git',
        args: ['clone', parsed.cloneUrl, targetPath],
        display: `git clone ${parsed.cloneUrl} ${targetPath}`,
      }
      emitLog({ step, line: `Cloning ${parsed.cloneUrl}` })
      await runSetupProcess({ step, spec, spawnProcess, emitStatus, emitLog, cwd: root })
      await recordProject(targetPath)
      return { path: targetPath, projectKey: resolveProjectKey(targetPath) }
    })
  })

  async function runExclusive<T>(step: SetupStreamStep, task: () => Promise<T>): Promise<T> {
    if (activeStep) throw new Error(`Setup step "${activeStep}" is already running.`)
    activeStep = step
    try {
      return await task()
    } finally {
      if (activeStep === step) activeStep = null
    }
  }
}

function installStepForAgent(agent: SetupAgent): SetupStreamStep {
  return agent === 'claude' ? 'install-claude' : 'install-codex'
}

function checkAgentAuth(agent: SetupAgent): SetupAgentAuthCheckResult {
  const installed = agent === 'claude'
    ? !!resolveAgentBinary('claude-code')
    : !!resolveAgentBinary('codex')
  return {
    agent,
    installed,
    authenticated: agent === 'claude' ? hasClaudeAuth() : null,
  }
}

function requireAuthenticatedSetupContext(ctx: HandlerCtx): void {
  if (!ctx.deviceId) throw new Error('Setup actions require an authenticated device.')
}

function commandExists(command: string): boolean {
  try {
    execFileSync('which', [command], { encoding: 'utf8', env: getCliEnv(), timeout: 3000 })
    return true
  } catch {
    return false
  }
}

async function runSetupProcess(opts: {
  step: SetupStreamStep
  spec: ProcessCommandSpec
  spawnProcess: SpawnProcess
  emitStatus(event: SetupStatusEvent): void
  emitLog(event: SetupLogEvent): void
  cwd?: string
}): Promise<SetupStepResult> {
  const { step, spec, spawnProcess, emitStatus, emitLog, cwd } = opts
  emitStatus({ step, status: 'running' })

  const child = spawnProcess(spec.command, spec.args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: getCliEnv({ FORCE_COLOR: '0' }),
  })

  let settled = false
  const stdout = createLineBuffer((line) => emitLog({ step, line }))
  const stderr = createLineBuffer((line) => emitLog({ step, line }))
  child.stdout?.on('data', (chunk) => stdout.write(chunk))
  child.stderr?.on('data', (chunk) => stderr.write(chunk))

  return await new Promise<SetupStepResult>((resolve, reject) => {
    const finish = (status: 'done' | 'failed', error?: string) => {
      if (settled) return
      settled = true
      stdout.flush()
      stderr.flush()
      emitStatus(error ? { step, status, error } : { step, status })
      const result: SetupStepResult = { step, status, error }
      if (status === 'failed') reject(new Error(error ?? 'Setup step failed.'))
      else resolve(result)
    }

    child.once('error', (err) => {
      finish('failed', err instanceof Error ? err.message : String(err))
    })
    child.once('close', (code) => {
      if (code === 0) finish('done')
      else finish('failed', `Exited with code ${code ?? 'unknown'}`)
    })
  })
}

function createLineBuffer(onLine: (line: string) => void): { write(chunk: Buffer | string): void; flush(): void } {
  let buffered = ''
  let emitted = 0
  const emit = (value: string) => {
    const line = value.replace(ANSI_RE, '').trimEnd()
    if (!line.trim()) return
    emitted++
    if (emitted > MAX_SETUP_LOG_LINES) return
    onLine(line)
  }
  return {
    write(chunk) {
      buffered += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk)
      const parts = buffered.split(/\r?\n/)
      buffered = parts.pop() ?? ''
      for (const part of parts) emit(part)
    },
    flush() {
      if (!buffered) return
      emit(buffered)
      buffered = ''
    },
  }
}

function parseHttpsCloneUrl(cloneUrl: string): CloneUrlInfo | null {
  try {
    const url = new URL(cloneUrl)
    if (url.protocol !== 'https:' || !validHost(url.hostname) || url.username || url.password) return null
    if (!/^\/[A-Za-z0-9._~/-]+\.git$/.test(url.pathname)) return null
    return { cloneUrl, repoName: repoNameFromPath(url.pathname) }
  } catch {
    return null
  }
}

function parseSshCloneUrl(cloneUrl: string): CloneUrlInfo | null {
  try {
    const url = new URL(cloneUrl)
    if (url.protocol !== 'ssh:' || !url.username || !validHost(url.hostname)) return null
    if (!/^\/[A-Za-z0-9._~/-]+\.git$/.test(url.pathname)) return null
    return { cloneUrl, repoName: repoNameFromPath(url.pathname) }
  } catch {
    return null
  }
}

function parseScpLikeCloneUrl(cloneUrl: string): CloneUrlInfo | null {
  const match = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):([A-Za-z0-9._~/-]+\.git)$/.exec(cloneUrl)
  if (!match || !validHost(match[2]) || !match[3].includes('/')) return null
  return { cloneUrl, repoName: repoNameFromPath(match[3]) }
}

function repoNameFromPath(value: string): string {
  return basename(value).replace(/\.git$/i, '') || 'project'
}

function validHost(host: string): boolean {
  return /^[A-Za-z0-9.-]+$/.test(host) && !host.startsWith('.') && !host.endsWith('.')
}

function uniqueProjectPath(root: string, name: string): string {
  let candidate = path.join(root, name)
  let suffix = 2
  while (existsSync(candidate)) {
    candidate = path.join(root, `${name}-${suffix}`)
    suffix++
  }
  return candidate
}
