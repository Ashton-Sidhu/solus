import { execFileSync, spawn as nodeSpawn, type ChildProcess } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { AGENT_BIN, type AgentId, type CloneAuth, type CloneProtocol, type GitCommitIdentity, type HostReadiness, type ServerCapabilities, type SetupAdoptProjectResult, type SetupAgent, type SetupAgentAuthCheckResult, type SetupCloneProjectResult, type SetupGithubRepo, type SetupGithubReposResult, type SetupLogEvent, type SetupSshAccessResult, type SetupStatusEvent, type SetupStepResult, type SetupStreamStep, type SetupVerification } from '../../../shared/types'
import type { SolusServer, HandlerCtx } from '../server'
import { getCliEnv } from '../../cli-env'
import { loadToken as loadGithubToken } from '../../providers/github/token-store'
import { GitHubAuth } from '../../providers/github/auth'
import { buildClient } from '../../providers/github/octokit'
import { PARAKEET_MODEL_DIR } from '../../model-downloader'
import { getServerSettings, setProjectsBaseDirectory, setServerName } from '../settings'
import { expandHome } from './lib/host-path'
import {
  applyCloneProtocol,
  buildAgentInstallCommand,
  buildGitInstallCommand,
  commandExists,
  isValidCloneHost,
  parseCloneUrlParts,
  resolveCloneDestination,
  validateCloneUrl,
} from './setup-commands'

const ANSI_RE = /\x1b\[[0-9;]*m/g
const MAX_SETUP_LOG_LINES = 1_000
/** Probes must never hang the readiness rail; nothing here talks to the network. */
const PROBE_TIMEOUT_MS = 2_000
const SSH_PROBE_TIMEOUT_MS = 8_000
/** The git config key whose helper answers github.com HTTPS credentials. */
const GITHUB_CREDENTIAL_KEY = 'credential.https://github.com.helper'

/**
 * `GIT_ASKPASS` is called once per prompt with the prompt text as argv[1]; the
 * answer goes to stdout. Keeping both values in the environment means the token
 * never reaches argv, the remote URL, or `.git/config`.
 */
const GIT_ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  Username*|username*) printf '%s\\n' "$SOLUS_GIT_USERNAME" ;;
  *) printf '%s\\n' "$SOLUS_GIT_PASSWORD" ;;
esac
`

interface ProcessCommandSpec {
  command: string
  args: string[]
  display: string
}

export type SpawnProcess = (
  command: string,
  args: string[],
  options: Parameters<typeof nodeSpawn>[2],
) => ChildProcess

export interface SetupHandlerDeps {
  spawnProcess?: SpawnProcess
  hasCommand?: (command: string) => boolean
  resolveAgentBinary?: typeof resolveAgentBinary
  hasClaudeAuth?: () => boolean
  hasCodexAuth?: () => boolean
  loadGithubToken?: typeof loadGithubToken
  registerProject?: (path: string) => Promise<string>
}

export interface AgentAuthProbeDeps {
  resolveAgentBinary?: typeof resolveAgentBinary
  hasClaudeAuth?: () => boolean
  hasCodexAuth?: () => boolean
}

export interface CapabilityProbeOptions {
  headless: boolean
  desktopHandlers: boolean
  version: string
}

export async function probeServerCapabilities(opts: CapabilityProbeOptions): Promise<ServerCapabilities> {
  // The manifest is loaded on demand because it pulls in `node:sqlite`, which
  // only the packaged runtime has.
  const { listProjects } = await import('../../project-config/projects-manifest')
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
    projectsBaseDirectory: getServerSettings().projectsBaseDirectory,
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

/** Codex writes successful CLI login credentials here; checking it never reaches the network. */
export function hasCodexAuth(): boolean {
  const configuredHome = process.env.CODEX_HOME?.trim()
  return existsSync(join(configuredHome || join(homedir(), '.codex'), 'auth.json'))
}

export function hasGithubAuth(): boolean {
  try {
    return !!loadGithubToken()
  } catch {
    return false
  }
}

/**
 * Everything the "New project" dialog needs to decide whether a host can clone
 * and then push. Nothing here touches the network, so it stays cheap enough to
 * run every time the dialog opens.
 */
export function probeHostReadiness(
  hasCommand: (command: string) => boolean = commandExists,
  agentDeps: AgentAuthProbeDeps = {},
): HostReadiness {
  const version = runProbe('git', ['--version'])
  const token = safeLoadGithubToken()
  const ghCli = hasCommand('gh')
  return {
    platform: process.platform,
    home: homedir(),
    projectsRoot: setupProjectsRoot(),
    git: {
      installed: !!version,
      version,
      identity: readGitIdentity(),
      credentialHelper: !!runProbe('git', ['config', '--global', '--get', GITHUB_CREDENTIAL_KEY]),
    },
    github: {
      solusToken: !!token,
      solusLogin: token?.login ?? null,
      ghCli,
      // `gh auth status` reports on stderr either way, so only its exit code says
      // whether the CLI actually holds credentials.
      ghAuthenticated: ghCli && probeSucceeds('gh', ['auth', 'status']),
    },
    ssh: { publicKeys: listSshPublicKeys() },
    agents: {
      claude: agentReadiness('claude', agentDeps),
      codex: agentReadiness('codex', agentDeps),
    },
    installGit: version ? null : buildGitInstallCommand({ hasCommand }),
  }
}

export function coerceSetupAgent(value: unknown): SetupAgent {
  if (value === 'claude' || value === 'codex') return value
  throw new Error('Unsupported setup agent.')
}







/**
 * Where projects land on this host — the root the "Open project" primary action
 * commits to. Settings → General owns the answer; a host that never set one
 * falls back to its own home folder rather than burying checkouts somewhere the
 * user would never think to look.
 */
export function setupProjectsRoot(
  settings: Pick<ReturnType<typeof getServerSettings>, 'projectsBaseDirectory'> = getServerSettings(),
  homeDirectory = homedir(),
): string {
  const configured = settings.projectsBaseDirectory?.trim()
  if (configured) return expandHome(configured, homeDirectory)
  return homeDirectory
}

export function registerSetupHandlers(server: SolusServer, deps: SetupHandlerDeps = {}): void {
  const spawnProcess = deps.spawnProcess ?? nodeSpawn
  const hasCommand = deps.hasCommand ?? commandExists
  const loadStoredGithubToken = deps.loadGithubToken ?? loadGithubToken
  /** The last step of both cloning and adopting; returns the key both promise. Loaded on demand — see `probeServerCapabilities`. */
  const registerProject = deps.registerProject ?? (async (path: string) => {
    const [{ recordProject }, { resolveProjectKey }] = await Promise.all([
      import('../../project-config/projects-manifest'),
      import('../../project-config/project-config'),
    ])
    await recordProject(path)
    return resolveProjectKey(path)
  })
  let activeStep: SetupStreamStep | null = null
  let activeAgentSignIn: {
    child: ChildProcess
    completion: Promise<void>
  } | null = null
  /** The one path `clean: true` is allowed to delete: what this host's last clone left behind. */
  let lastFailedCloneDestination: string | null = null

  const emitStatus = (event: SetupStatusEvent) => server.broadcast('setup-status', event)
  const emitLog = (event: SetupLogEvent) => server.broadcast('setup-log', event)

  server.register('setServerName', (args, ctx) => {
    requireAuthenticatedSetupContext(ctx)
    const [name] = args as [string]
    const next = setServerName(String(name ?? ''))
    return { name: next.name }
  })

  server.register('setProjectsBaseDirectory', (args, ctx) => {
    requireAuthenticatedSetupContext(ctx)
    const [path] = args as [string]
    const next = setProjectsBaseDirectory(String(path ?? ''))
    return { projectsBaseDirectory: next.projectsBaseDirectory }
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
    return checkAgentAuth(setupAgent, deps)
  })

  server.register('setupAgentSignIn', async (args, ctx): Promise<SetupStepResult> => {
    requireAuthenticatedSetupContext(ctx)
    const [{ agent }] = args as [{ agent: unknown }]
    const setupAgent = coerceSetupAgent(agent)
    const step = signInStepForAgent(setupAgent)
    const spec = agentSignInCommand(setupAgent)
    let stdout = ''
    let emittedVerification = ''
    // A fresh attempt supersedes an abandoned device-code prompt. This also
    // recovers after a client disappears before it can send the explicit cancel.
    await cancelActiveAgentSignIn()

    const signInState: {
      child: ChildProcess | null
      completion: Promise<void>
    } = {
      child: null,
      completion: Promise.resolve(),
    }
    // Device auth can wait for 15 minutes and has its own replacement/cancel
    // lifecycle below. It must not hold the setup lock: cloning a repository
    // does not depend on agent auth and should remain available while the user
    // finishes sign-in in their browser.
    const signIn = (async () => {
      emitLog({ step, line: `Running ${spec.display}` })
      return await runSetupProcess({
        step,
        spec,
        spawnProcess,
        emitStatus,
        emitLog,
        detached: true,
        onSpawn(child) {
          signInState.child = child
        },
        onStdoutLine(line) {
          stdout = `${stdout}\n${line}`.slice(-8_192)
          const verification = parseAgentSignInVerification(stdout)
          if (!verification) return
          const key = `${verification.url}\n${verification.code}`
          if (key === emittedVerification) return
          emittedVerification = key
          emitStatus({ step, status: 'running', verification })
        },
        verifySuccess() {
          const auth = checkAgentAuth(setupAgent, deps)
          if (auth.installed && auth.authenticated === true) return null
          const label = setupAgent === 'claude' ? 'Claude' : 'Codex'
          return `${label} sign-in finished, but ${label} is still not signed in on this host.`
        },
      })
    })()
    signInState.completion = signIn.then(() => {}, () => {})
    if (signInState.child) {
      activeAgentSignIn = {
        child: signInState.child,
        completion: signInState.completion,
      }
    }
    try {
      return await signIn
    } finally {
      if (activeAgentSignIn?.completion === signInState.completion) {
        activeAgentSignIn = null
      }
    }
  })

  server.register('setupCancelAgentSignIn', async (_args, ctx) => {
    requireAuthenticatedSetupContext(ctx)
    return { cancelled: await cancelActiveAgentSignIn() }
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

  server.register('setupHostReadiness', (_args, ctx): HostReadiness => {
    requireAuthenticatedSetupContext(ctx)
    return probeHostReadiness(hasCommand, deps)
  })

  server.register('setupInstallGit', async (_args, ctx) => {
    requireAuthenticatedSetupContext(ctx)
    const step: SetupStreamStep = 'install-git'
    const spec = buildGitInstallCommand({ hasCommand })
    if (!spec) throw new Error('No package manager was found on this host. Install git manually, then re-check.')
    if (!spec.autoRunnable) {
      throw new Error(`Solus can’t run this without elevation. Run it on the host, then re-check:\n${spec.display}`)
    }

    return runExclusive(step, async () => {
      emitLog({ step, line: `Running ${spec.display}` })
      try {
        return await runSetupProcess({ step, spec, spawnProcess, emitStatus, emitLog })
      } catch (err) {
        emitStatus({ step, status: 'failed', error: err instanceof Error ? err.message : String(err) })
        throw err
      }
    })
  })

  server.register('setupSetGitIdentity', (args, ctx): GitCommitIdentity => {
    requireAuthenticatedSetupContext(ctx)
    const [{ name, email }] = args as [{ name: unknown; email: unknown }]
    const identity = {
      name: coerceConfigValue(name, 'Name'),
      email: coerceConfigValue(email, 'Email'),
    }
    execFileSync('git', ['config', '--global', 'user.name', identity.name], { env: getCliEnv(), timeout: PROBE_TIMEOUT_MS })
    execFileSync('git', ['config', '--global', 'user.email', identity.email], { env: getCliEnv(), timeout: PROBE_TIMEOUT_MS })
    return identity
  })

  server.register('setupCheckSshAccess', (args, ctx): SetupSshAccessResult => {
    requireAuthenticatedSetupContext(ctx)
    const [{ host }] = args as [{ host?: unknown }]
    const target = typeof host === 'string' && host.trim() ? host.trim() : 'github.com'
    if (!isValidCloneHost(target)) throw new Error('That is not a valid host name.')

    // A code host answers the shell request with a greeting and a non-zero exit,
    // so the greeting — not the exit code — is what says the key is accepted.
    let output = ''
    try {
      output = execFileSync('ssh', [
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', `ConnectTimeout=${Math.round(SSH_PROBE_TIMEOUT_MS / 1000)}`,
        '-T', `git@${target}`,
      ], { encoding: 'utf8', env: getCliEnv(), timeout: SSH_PROBE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] })
      return { host: target, ok: true, message: output.trim() || `Connected to ${target}.` }
    } catch (err) {
      const failure = err as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string }
      output = [failure.stdout, failure.stderr].map((part) => part?.toString() ?? '').join('\n').trim()
      const ok = /successfully authenticated/i.test(output)
      return { host: target, ok, message: output || failure.message || `Couldn’t reach ${target} over SSH.` }
    }
  })

  server.register('setupAuthorizeGhCli', async (_args, ctx) => {
    requireAuthenticatedSetupContext(ctx)
    const token = safeLoadGithubToken()
    if (!token) throw new Error('Connect GitHub on this host before authorizing the gh CLI.')
    if (!hasCommand('gh')) throw new Error('The GitHub CLI (gh) is not installed on this host.')

    // `--with-token` reads stdin, so the token never becomes an argument.
    execFileSync('gh', ['auth', 'login', '--with-token'], {
      input: `${token.accessToken}\n`,
      env: getCliEnv(),
      timeout: SSH_PROBE_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { ok: true }
  })

  server.register('setupInstallGitCredentialHelper', (_args, ctx) => {
    requireAuthenticatedSetupContext(ctx)
    const solusPath = resolveSolusCli()
    if (!solusPath) throw new Error('The Solus CLI was not found on this host, so git has nothing to ask for credentials.')
    // The leading "!" makes git run this as a shell command rather than looking
    // for a `git-credential-<name>` binary — so the path has to survive a shell.
    execFileSync('git', ['config', '--global', GITHUB_CREDENTIAL_KEY, `!'${solusPath}' git-credential`], {
      env: getCliEnv(),
      timeout: PROBE_TIMEOUT_MS,
    })
    return { ok: true }
  })

  server.register('setupCloneProject', async (args, ctx): Promise<SetupCloneProjectResult> => {
    requireAuthenticatedSetupContext(ctx)
    const [{ cloneUrl, name, destination, protocol, clean }] = args as [{
      cloneUrl: unknown
      name?: unknown
      destination?: unknown
      protocol?: unknown
      clean?: unknown
    }]
    const parsed = validateCloneUrl(String(cloneUrl ?? ''))
    const selectedProtocol = coerceCloneProtocol(protocol)
    const cloneUrls = selectedProtocol
      ? [applyCloneProtocol(parsed.cloneUrl, selectedProtocol)]
      : [
          applyCloneProtocol(parsed.cloneUrl, 'ssh'),
          applyCloneProtocol(parsed.cloneUrl, 'https'),
        ]
    const step: SetupStreamStep = 'clone'

    return runExclusive(step, async () => {
      const projectsRoot = setupProjectsRoot()
      const targetPath = resolveCloneDestination({
        destination: typeof destination === 'string' && destination.trim() ? expandHome(destination.trim()) : undefined,
        name: typeof name === 'string' ? name : undefined,
        repoName: parsed.repoName,
        projectsRoot,
      })
      // Only a directory this host's own clone left behind can be removed, so a
      // stray `clean` can never delete a folder the user chose.
      if (clean === true && targetPath === lastFailedCloneDestination) {
        await rm(targetPath, { recursive: true, force: true })
        lastFailedCloneDestination = null
      }
      await assertEmptyDestination(targetPath)
      const targetExistedBeforeClone = existsSync(targetPath)

      const parent = dirname(targetPath)
      await mkdir(parent, { recursive: true })
      let auth: CloneAuth | null = null

      for (const [index, attemptUrl] of cloneUrls.entries()) {
        const isHttps = attemptUrl.startsWith('https://')
        const attemptParts = parseCloneUrlParts(attemptUrl)
        const token = isHttps && attemptParts?.host.toLowerCase() === 'github.com'
          ? safeLoadGithubToken(loadStoredGithubToken)
          : null
        const askpass = token ? await createGitAskpassHelper() : null
        // Cloning into a basename from the parent keeps git's counting/receiving
        // lines on the stream; a full destination path suppresses them.
        const spec: ProcessCommandSpec = {
          command: 'git',
          args: ['clone', '--progress', attemptUrl, basename(targetPath)],
          display: `git clone --progress ${attemptUrl} ${basename(targetPath)}`,
        }
        emitLog({ step, line: `Cloning ${attemptUrl} into ${targetPath}` })
        try {
          await runSetupProcess({
            step,
            spec,
            spawnProcess,
            emitStatus,
            emitLog,
            cwd: parent,
            emitFailureStatus: index === cloneUrls.length - 1,
            env: askpass && token
              ? {
                  GIT_ASKPASS: askpass.path,
                  GIT_TERMINAL_PROMPT: '0',
                  SOLUS_GIT_USERNAME: 'x-access-token',
                  SOLUS_GIT_PASSWORD: token.accessToken,
                }
              : {
                  GIT_TERMINAL_PROMPT: '0',
                  ...(isHttps ? {} : {
                    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10',
                  }),
                },
          })
          auth = isHttps ? (token ? 'token' : 'anonymous') : 'ssh'
          break
        } catch (err) {
          const hasFallback = index < cloneUrls.length - 1
          if (!hasFallback) {
            // Name only a partial checkout this clone created, so `clean` can
            // never delete a folder the user already owned.
            if (!targetExistedBeforeClone && existsSync(targetPath)) {
              lastFailedCloneDestination = targetPath
            }
            throw err
          }

          try {
            await prepareDestinationForCloneRetry(targetPath, targetExistedBeforeClone)
          } catch (cleanupErr) {
            const error = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
            emitStatus({ step, status: 'failed', error })
            throw cleanupErr
          }
          emitLog({ step, line: 'SSH clone failed; trying HTTPS.' })
        } finally {
          if (askpass) await rm(askpass.directory, { recursive: true, force: true }).catch(() => {})
        }
      }

      if (!auth) throw new Error('Clone failed without an authentication result.')
      lastFailedCloneDestination = null
      return { path: targetPath, projectKey: await registerProject(targetPath), auth }
    })
  })

  server.register('setupAdoptProject', async (args, ctx): Promise<SetupAdoptProjectResult> => {
    requireAuthenticatedSetupContext(ctx)
    const [{ path, cloneUrl }] = args as [{ path: unknown; cloneUrl?: unknown }]
    const rawPath = typeof path === 'string' ? path.trim() : ''
    if (!rawPath) throw new Error('A checkout path is required.')
    const checkoutPath = expandHome(rawPath)
    const checkoutRoot = readGitCheckoutRoot(checkoutPath)
    if (!checkoutRoot) throw new Error(`There’s no git checkout at ${checkoutPath}.`)

    if (typeof cloneUrl === 'string' && cloneUrl.trim()) {
      const expected = cloneRepoKey(validateCloneUrl(cloneUrl).cloneUrl)
      if (!expected) throw new Error('The clone URL must name both an owner and repository.')
      const origin = readGitOrigin(checkoutPath)
      if (!origin) {
        throw new Error(`The git checkout at ${checkoutPath} has no origin configured.`)
      }
      const actual = cloneRepoKey(origin)
      if (!actual || actual !== expected) {
        throw new Error(`The git checkout at ${checkoutPath} has origin ${origin}, not ${expected}.`)
      }
    }

    return { path: checkoutPath, projectKey: await registerProject(checkoutPath) }
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

  async function cancelActiveAgentSignIn(): Promise<boolean> {
    const signIn = activeAgentSignIn
    if (!signIn) return false
    terminateProcessTree(signIn.child, 'SIGTERM')
    await signIn.completion
    return true
  }
}

function installStepForAgent(agent: SetupAgent): SetupStreamStep {
  return agent === 'claude' ? 'install-claude' : 'install-codex'
}

function signInStepForAgent(agent: SetupAgent): SetupStreamStep {
  return agent === 'claude' ? 'signin-claude' : 'signin-codex'
}

function agentSignInCommand(agent: SetupAgent): ProcessCommandSpec {
  return agent === 'claude'
    ? { command: 'claude', args: ['setup-token'], display: 'claude setup-token' }
    : { command: 'codex', args: ['login', '--device-auth'], display: 'codex login --device-auth' }
}

/** Readiness cares only about "can this host run the agent", so an unknown auth probe reads as not signed in. */
function agentReadiness(agent: SetupAgent, deps: AgentAuthProbeDeps = {}): { installed: boolean; signedIn: boolean } {
  const check = checkAgentAuth(agent, deps)
  return { installed: check.installed, signedIn: check.installed && check.authenticated === true }
}

function checkAgentAuth(agent: SetupAgent, deps: AgentAuthProbeDeps = {}): SetupAgentAuthCheckResult {
  const resolveBinary = deps.resolveAgentBinary ?? resolveAgentBinary
  const checkClaudeAuth = deps.hasClaudeAuth ?? hasClaudeAuth
  const checkCodexAuth = deps.hasCodexAuth ?? hasCodexAuth
  const installed = agent === 'claude'
    ? !!resolveBinary('claude-code')
    : !!resolveBinary('codex')
  return {
    agent,
    installed,
    authenticated: installed
      ? (agent === 'claude' ? checkClaudeAuth() : checkCodexAuth())
      : false,
  }
}

/**
 * Agent CLIs vary their surrounding prose, so only the two durable device-flow
 * facts are scraped. Missing or unfamiliar output simply returns null while the
 * unmodified lines keep streaming to the user.
 */
export function parseAgentSignInVerification(output: string): SetupVerification | null {
  const text = output.replace(ANSI_RE, '')
  const urls = [...text.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)]
  const url = urls.at(-1)?.[0]?.replace(/[.,;:]+$/, '')
  const codePatterns = [
    /enter\s+(?:this\s+)?(?:one[- ]time\s+)?code(?:[ \t]*\([^)\r\n]*\))?[ \t]*(?:is|:)?[ \t]*\r?\n[ \t]*([A-Z0-9][A-Z0-9-]{3,31})/i,
    /(?:verification|device)\s+code\s*(?:is|:)\s*([A-Z0-9][A-Z0-9-]{3,31})/i,
    /\bcode\s*(?:is|:)\s*([A-Z0-9][A-Z0-9-]{3,31})/i,
  ]
  const code = codePatterns
    .map((pattern) => pattern.exec(text)?.[1])
    .find((candidate): candidate is string => !!candidate)
  return url && code ? { url, code } : null
}

function requireAuthenticatedSetupContext(ctx: HandlerCtx): void {
  if (!ctx.deviceId) throw new Error('Setup actions require an authenticated device.')
}

function coerceCloneProtocol(value: unknown): CloneProtocol | undefined {
  if (value === 'https' || value === 'ssh') return value
  return undefined
}

/** Git config values reach a shell-free execFile, but newlines would still corrupt the config file. */
function coerceConfigValue(value: unknown, label: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) throw new Error(`${label} is required.`)
  if (trimmed.length > 200 || /[\r\n\x00]/.test(trimmed)) throw new Error(`${label} contains characters git can’t store.`)
  return trimmed
}

/** `host/owner/repo`, independent of whether git stored SSH or HTTPS as origin. */
function cloneRepoKey(cloneUrl: string): string | null {
  const parts = parseCloneUrlParts(cloneUrl)
  if (!parts) return null
  const repoPath = parts.repoPath.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
  if (!repoPath.includes('/')) return null
  return `${parts.host.toLowerCase()}/${repoPath}`
}

function readGitCheckoutRoot(checkoutPath: string): string | null {
  try {
    return execFileSync('git', ['-C', checkoutPath, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      env: getCliEnv(),
      timeout: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim() || null
  } catch {
    return null
  }
}

function readGitOrigin(checkoutPath: string): string | null {
  try {
    return execFileSync('git', ['-C', checkoutPath, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
      env: getCliEnv(),
      timeout: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim() || null
  } catch {
    return null
  }
}

/** Absolute path so the credential helper keeps working under git's own PATH. */
function resolveSolusCli(): string | null {
  try {
    return execFileSync('which', ['solus'], { encoding: 'utf8', env: getCliEnv(), timeout: PROBE_TIMEOUT_MS }).trim() || null
  } catch {
    return null
  }
}

/** Runs a short read-only command and returns its trimmed output, or null if it can't. */
function runProbe(command: string, args: string[]): string | null {
  try {
    const out = execFileSync(command, args, {
      encoding: 'utf8',
      env: getCliEnv(),
      timeout: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return out.trim() || null
  } catch {
    return null
  }
}

/** For probes whose answer is the exit code rather than anything they print. */
function probeSucceeds(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, {
      env: getCliEnv(),
      timeout: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

/** Both halves are required before a commit works, so a partial identity reads as none. */
function readGitIdentity(): GitCommitIdentity | null {
  const name = runProbe('git', ['config', '--global', '--get', 'user.name'])
  const email = runProbe('git', ['config', '--global', '--get', 'user.email'])
  return name && email ? { name, email } : null
}

function listSshPublicKeys(): string[] {
  try {
    return readdirSync(join(homedir(), '.ssh')).filter((name) => name.endsWith('.pub')).sort()
  } catch {
    return []
  }
}

function safeLoadGithubToken(
  loader: typeof loadGithubToken = loadGithubToken,
): ReturnType<typeof loadGithubToken> {
  try {
    return loader()
  } catch {
    return null
  }
}

/**
 * A 0700 temp helper that feeds git the host's own token. It is written per
 * clone and removed in a `finally`, so no credential outlives the process.
 */
async function createGitAskpassHelper(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'solus-git-askpass-'))
  await chmod(directory, 0o700)
  const helperPath = join(directory, 'git-askpass.sh')
  await writeFile(helperPath, GIT_ASKPASS_SCRIPT, { mode: 0o700 })
  await chmod(helperPath, 0o700)
  return { directory, path: helperPath }
}

/** A destination that already holds files is never clobbered — the user chooses. */
async function assertEmptyDestination(target: string): Promise<void> {
  const contents = await readdir(target).catch(() => null)
  if (contents === null) return
  if (contents.length > 0) {
    throw new Error(`${target} already exists and is not empty. Choose another folder or remove it first.`)
  }
}

/**
 * SSH fallback may remove only a destination that this clone created. An
 * existing empty folder can be reused only if SSH left it empty.
 */
async function prepareDestinationForCloneRetry(target: string, existedBeforeClone: boolean): Promise<void> {
  if (!existsSync(target)) return
  if (!existedBeforeClone) {
    await rm(target, { recursive: true, force: true })
    return
  }
  const contents = await readdir(target)
  if (contents.length === 0) return
  throw new Error(
    `SSH left files in ${target}. Solus didn’t remove them because the folder already existed; empty it before trying HTTPS.`,
  )
}

async function runSetupProcess(opts: {
  step: SetupStreamStep
  spec: ProcessCommandSpec
  spawnProcess: SpawnProcess
  emitStatus(event: SetupStatusEvent): void
  emitLog(event: SetupLogEvent): void
  cwd?: string
  /** Secrets belong here, never in `spec.args` — argv is world-readable. */
  env?: Record<string, string>
  /** Interactive commands get their own process group so cancellation reaches CLI wrappers and children. */
  detached?: boolean
  onSpawn?(child: ChildProcess): void
  onStdoutLine?(line: string): void
  /** A fallback attempt is not a failed setup step until its final attempt fails. */
  emitFailureStatus?: boolean
  /** Returns a user-facing error when a zero exit did not achieve the intended state. */
  verifySuccess?(): string | null
}): Promise<SetupStepResult> {
  const {
    step,
    spec,
    spawnProcess,
    emitStatus,
    emitLog,
    cwd,
    env,
    detached = false,
    onSpawn,
    onStdoutLine,
    emitFailureStatus = true,
    verifySuccess,
  } = opts
  emitStatus({ step, status: 'running' })

  const child = spawnProcess(spec.command, spec.args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached,
    env: getCliEnv({ FORCE_COLOR: '0', ...env }),
  })
  onSpawn?.(child)

  let settled = false
  const stdout = createLineBuffer((line) => {
    emitLog({ step, line })
    onStdoutLine?.(line)
  })
  const stderr = createLineBuffer((line) => emitLog({ step, line }))
  child.stdout?.on('data', (chunk) => stdout.write(chunk))
  child.stderr?.on('data', (chunk) => stderr.write(chunk))

  return await new Promise<SetupStepResult>((resolve, reject) => {
    const finish = (status: 'done' | 'failed', error?: string) => {
      if (settled) return
      settled = true
      stdout.flush()
      stderr.flush()
      if (status === 'done' || emitFailureStatus) {
        emitStatus(error ? { step, status, error } : { step, status })
      }
      const result: SetupStepResult = { step, status, error }
      if (status === 'failed') reject(new Error(error ?? 'Setup step failed.'))
      else resolve(result)
    }

    child.once('error', (err) => {
      finish('failed', err instanceof Error ? err.message : String(err))
    })
    child.once('close', (code, signal) => {
      if (signal) {
        finish('failed', 'Setup step cancelled.')
        return
      }
      if (code === 0) {
        const verificationError = verifySuccess?.()
        if (verificationError) finish('failed', verificationError)
        else finish('done')
      }
      else finish('failed', `Exited with code ${code ?? 'unknown'}`)
    })
  })
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // The wrapper may have exited between the status check and this signal.
    }
  }
  child.kill(signal)
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
