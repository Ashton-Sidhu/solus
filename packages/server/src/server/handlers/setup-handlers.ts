import { execFileSync, spawn as nodeSpawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, readdirSync } from 'fs'
import { mkdir, readdir, rm } from 'fs/promises'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import { z } from 'zod'
import { AGENT_BIN, type AgentId, type CloneAuth, type CloneProtocol, type DispatchHistoryRoot, type GitCommitIdentity, type GithubDelegatedCredential, type HostReadiness, type ServerCapabilities, type SetupAdoptProjectResult, type SetupAgent, type SetupAgentAuthCheckResult, type SetupCloneProjectResult, type SetupGithubRepo, type SetupGithubReposResult, type SetupLogEvent, type SetupPrepareProjectResult, type SetupSshAccessResult, type SetupStatusEvent, type SetupStepResult, type SetupStreamStep } from '@solus/contracts/types'
import { providerLoginConnected } from '../../seats/seat-login'
import type { SolusServer, HandlerCtx } from '../server'
import type { Principal } from '../principal'
import type { HostEventPublisher } from '../../events/host-event-publisher'
import { getCliEnv } from '../../cli-env'
import { runAsync } from '../../git/exec'
import { createGitAskpassHelper, gitAuthEnv, type GitAuthEnv } from '../../git/git-auth-env'
import { loadToken as loadGithubToken } from '../../providers/github/token-store'
import { saveDelegation } from '../../providers/github/delegation-store'
import { GitHubAuth } from '../../providers/github/auth'
import { buildClient } from '../../providers/github/octokit'
import { hasGithubCliScopes, parseGithubScopes } from '@solus/contracts/github-auth'
import { PARAKEET_MODEL_DIR } from '../../model-downloader'
import { getHostConfig, getServerSettings, setProjectsBaseDirectory } from '../settings'
import { WORKSPACE_DIR } from '../../workspace'
import { listProjects, recordProject } from '../../project-config/projects-manifest'
import { resolveProjectKey } from '../../project-config/project-config'
import { expandHome } from './lib/host-path'
import { sshConnectionOptions } from './lib/ssh-options'
import {
  agentInstallCompatibilityError,
  applyCloneProtocol,
  buildAgentInstallCommand,
  buildPackageInstallCommand,
  commandExists,
  type InstallablePackage,
  isValidCloneHost,
  parseCloneUrlParts,
  resolveAgentOwnership,
  resolveCloneDestination,
  validateCloneUrl,
} from './setup-commands'
import { dispatchCheckoutPath, resolveDispatchHistoryRoots, resolveDispatchWorktree } from '../../project-config/dispatch-checkouts'
import { ensureBranchWorktree } from '../../git/worktree-manager'

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const MAX_SETUP_LOG_LINES = 1_000
/** Probes must never hang the readiness rail; nothing here talks to the network. */
const PROBE_TIMEOUT_MS = 2_000
const SSH_COMMAND_TIMEOUT_MS = 10_000
const GH_AUTH_TIMEOUT_MS = 10_000
/** The git config key whose helper answers github.com HTTPS credentials. */
const GITHUB_CREDENTIAL_KEY = 'credential.https://github.com.helper'
const MAX_DISPATCH_HISTORY_REPO_KEYS = 32

const setupAgentSchema = z.enum(['claude', 'codex'])
const delegatedCredentialSchema = z.object({
  accessToken: z.string(),
  login: z.string(),
}).strict()
const setupAgentRequestSchema = z.object({ agent: setupAgentSchema }).strict()
const setupPrepareProjectSchema = z.object({
  cloneUrl: z.string(),
  credential: delegatedCredentialSchema.optional(),
  worktreePath: z.string().trim().min(1).optional(),
  baseBranch: z.string().trim().min(1).optional(),
}).strict()
const setupCloneProjectSchema = z.object({
  cloneUrl: z.string(),
  name: z.string().optional(),
  destination: z.string().optional(),
  protocol: z.enum(['https', 'ssh']).optional(),
  clean: z.boolean().optional(),
  credential: delegatedCredentialSchema.optional(),
}).strict()
const setupSyncProjectSchema = z.object({
  path: z.string(),
  cloneUrl: z.string(),
}).strict()
const setupAdoptProjectSchema = z.object({
  path: z.string(),
  cloneUrl: z.string().optional(),
}).strict()

interface LineBuffer {
  write(chunk: Buffer | string): void
  flush(): void
}

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

export interface SetupHandlerDeps extends AgentAuthProbeDeps {
  events?: HostEventPublisher
  spawnProcess?: SpawnProcess
  hasCommand?: (command: string) => boolean
  loadGithubToken?: typeof loadGithubToken
  registerProject?: (path: string) => Promise<string>
  projectsRoot?: () => string
  assertNewWorkAllowed?: () => void
  onActiveStepsChanged?: (count: number) => void
  onProviderInstalled?: (agent: SetupAgent) => Promise<void>
}

export interface AgentAuthProbeDeps {
  resolveAgentBinary?: typeof whichAgentBinary
  hasClaudeAuth?: () => boolean
  hasCodexAuth?: () => boolean
}

export interface CapabilityProbeOptions {
  headless: boolean
  desktopHandlers: boolean
  version: string
  /** Who is asking: a member's pickers open on their own workspace (managed-hosts.md §3). */
  principal?: Principal
}

export async function probeServerCapabilities(opts: CapabilityProbeOptions): Promise<ServerCapabilities> {
  const projects = await listProjects().catch(() => [])
  return {
    headless: opts.headless,
    desktopHandlers: opts.desktopHandlers,
    agents: {
      claude: !!whichAgentBinary('claude-code'),
      codex: !!whichAgentBinary('codex'),
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
    // A member's pickers open on their own workspace; the owner's on the host setting.
    projectsBaseDirectory: opts.principal?.kind === 'org-member' ? projectsRootFor(opts.principal) : getServerSettings().projectsBaseDirectory,
    agentTaskLifecyclePolicy: getHostConfig().config.agentTaskLifecyclePolicy,
    workspacePath: WORKSPACE_DIR,
  }
}

/** Capability probes are synchronous and intentionally skip the launcher's cache. */
function whichAgentBinary(agentId: AgentId): string | null {
  const bin = AGENT_BIN[agentId]
  if (!bin) return null
  try {
    return execFileSync('which', [bin], { encoding: 'utf8', env: getCliEnv(), timeout: 3000 }).trim() || null
  } catch {
    return null
  }
}

/** The host login is the owner's seat: the seat module owns the one honest probe for it. */
export function hasClaudeAuth(
  succeeds?: (command: string, args: string[]) => boolean,
): boolean {
  return providerLoginConnected('claude-code', null, succeeds ? (command, args) => succeeds(command, args) : undefined)
}

export function hasCodexAuth(): boolean {
  return providerLoginConnected('codex', null)
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
  projectsRoot: string = setupProjectsRoot(),
): HostReadiness {
  // The version string decides nothing; running the probe is still how "is git
  // here at all?" gets answered.
  const gitInstalled = !!runProbe('git', ['--version'])
  const token = safeLoadGithubToken()
  const ghCli = hasCommand('gh')
  return {
    platform: process.platform,
    home: homedir(),
    projectsRoot,
    git: {
      installed: gitInstalled,
      identity: readGitIdentity(),
      credentialHelper: !!runProbe('git', ['config', '--global', '--get', GITHUB_CREDENTIAL_KEY]),
    },
    github: {
      solusToken: !!token,
      solusLogin: token?.login ?? null,
      solusScopes: token ? parseGithubScopes(token.scope) : undefined,
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
    installGit: gitInstalled ? null : buildPackageInstallCommand('git', { hasCommand }),
    installGh: ghCli ? null : buildPackageInstallCommand('gh', { hasCommand }),
  }
}

export function coerceSetupAgent(value: string): SetupAgent {
  const parsed = setupAgentSchema.safeParse(value)
  if (parsed.success) return parsed.data
  throw new Error('Unsupported setup agent.')
}







/**
 * Where projects land on this host — the root the "Open project" primary action
 * commits to. Settings → General owns the answer; a host that never set one
 * falls back to `SOLUS_PROJECTS_ROOT` (the managed image's volume path,
 * managed-hosts.md §3) and then to its own home folder rather than burying
 * checkouts somewhere the user would never think to look.
 */
export function setupProjectsRoot(
  settings: Pick<ReturnType<typeof getServerSettings>, 'projectsBaseDirectory'> = getServerSettings(),
  homeDirectory = homedir(),
  env: { SOLUS_PROJECTS_ROOT?: string } = process.env,
): string {
  const configured = settings.projectsBaseDirectory?.trim() || env.SOLUS_PROJECTS_ROOT?.trim()
  if (configured) return expandHome(configured, homeDirectory)
  return homeDirectory
}

/** A Better Auth user id; nothing that could walk the filesystem. */
const workspaceUserIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)

/**
 * Where one person's projects land (managed-hosts.md §3). The host's root for its
 * owner and for the host's own work; a member of the organization gets a directory
 * of their own beneath it, named by their account id, so each person clones into a
 * workspace that is theirs. It is a default, not a boundary: members see every
 * session and work on the host (decision 2026-09-15), and may open any path.
 */
export function projectsRootFor(principal: Principal | undefined, hostRoot = setupProjectsRoot()): string {
  if (principal?.kind !== 'org-member') return hostRoot
  const workspace = join(hostRoot, workspaceUserIdSchema.parse(principal.userId))
  mkdirSync(workspace, { recursive: true })
  return workspace
}

export function registerSetupHandlers(server: SolusServer, deps: SetupHandlerDeps = {}): void {
  const spawnProcess = deps.spawnProcess ?? nodeSpawn
  const hasCommand = deps.hasCommand ?? commandExists
  const loadStoredGithubToken = deps.loadGithubToken ?? loadGithubToken
  const projectsRoot = deps.projectsRoot ?? setupProjectsRoot
  /** The caller's own workspace beneath the host root (managed-hosts.md §3). */
  const projectsRootOf = (ctx: HandlerCtx) => projectsRootFor(ctx.principal, projectsRoot())
  /** The last step of both cloning and adopting; returns the key both promise. */
  const registerProject = deps.registerProject ?? (async (path: string) => {
    await recordProject(path)
    return resolveProjectKey(path)
  })
  const activeSteps = new Set<SetupStreamStep>()
  /** The one path `clean: true` is allowed to delete: what this host's last clone left behind. */
  let lastFailedCloneDestination: string | null = null

  const eventSink = (clientId: string | undefined) => ({
    emitStatus: (event: SetupStatusEvent) => {
      if (clientId) deps.events?.publish(clientId, 'setup.statusChanged', event)
    },
    emitLog: (event: SetupLogEvent) => {
      if (clientId) deps.events?.publish(clientId, 'setup.logAppended', event)
    },
  })

  server.register('resolveDispatchHistoryRoots', async (args, ctx): Promise<DispatchHistoryRoot[]> => {
    const deviceId = requireDeviceScopedSetupContext(ctx)
    const [requestRepoKeys] = args
    const repoKeys = z.array(z.string()).parse(requestRepoKeys)
    if (repoKeys.length > MAX_DISPATCH_HISTORY_REPO_KEYS) {
      throw new Error(`Dispatch history is limited to ${MAX_DISPATCH_HISTORY_REPO_KEYS} repositories per request.`)
    }
    return resolveDispatchHistoryRoots(projectsRootOf(ctx), deviceId, repoKeys)
  })

  server.register('setProjectsBaseDirectory', (args) => {
    const [path] = args
    const next = setProjectsBaseDirectory(z.string().parse(path))
    return { projectsBaseDirectory: next.projectsBaseDirectory }
  })

  server.register('setupInstallAgentCli', async (args, ctx) => {
    const { emitStatus, emitLog } = eventSink(ctx.clientId)
    const [request] = args
    const { agent: setupAgent } = setupAgentRequestSchema.parse(request)
    const step = installStepForAgent(setupAgent)

    return runExclusive(step, async () => {
      try {
        const compatibilityError = agentInstallCompatibilityError(setupAgent)
        if (compatibilityError) throw new Error(compatibilityError)
        const ownership = resolveAgentOwnership(setupAgent)
        if (ownership.kind === 'unmanaged') {
          const label = setupAgent === 'claude' ? 'Claude' : 'Codex'
          throw new Error(`${label} is already installed at ${ownership.resolvedPath}, outside Solus's installer. Update it there, then check again.`)
        }
        const spec = buildAgentInstallCommand(setupAgent, { hasCommand })
        emitLog({ step, line: `Running ${spec.display}` })
        const result = await runSetupProcess({ step, spec, spawnProcess, emitStatus, emitLog })
        await deps.onProviderInstalled?.(setupAgent)
        return result
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        emitStatus({ step, status: 'failed', error })
        throw err
      }
    })
  })

  server.register('setupCheckAgentAuth', (args): SetupAgentAuthCheckResult => {
    const [request] = args
    const { agent: setupAgent } = setupAgentRequestSchema.parse(request)
    return checkAgentAuth(setupAgent, deps)
  })

  // Signing an agent in is the seat connect (`seatConnectStart` and friends): the
  // host login is the owner's seat, so the wizard and a member's row share one relay.

  server.register('setupListGithubRepos', async (): Promise<SetupGithubReposResult> => {
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
    return probeHostReadiness(hasCommand, deps, projectsRootOf(ctx))
  })

  server.register('setupInstallGit', (_args, ctx) => {
    return installPackage('git', 'install-git', 'git', ctx.clientId)
  })

  server.register('setupInstallGh', (_args, ctx) => {
    return installPackage('gh', 'install-gh', 'the GitHub CLI', ctx.clientId)
  })

  /** The two packages Solus installs on a host, run the same way and reported on the same channel. */
  async function installPackage(
    pkg: InstallablePackage,
    step: SetupStreamStep,
    label: string,
    clientId: string | undefined,
  ) {
    const { emitStatus, emitLog } = eventSink(clientId)
    const spec = buildPackageInstallCommand(pkg, { hasCommand })
    if (!spec) throw new Error(`No package manager was found on this host. Install ${label} manually, then re-check.`)
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
  }

  server.register('setupSetGitIdentity', (args): GitCommitIdentity => {
    const [request] = args
    const { name, email } = z.object({ name: z.string(), email: z.string() }).strict().parse(request)
    const identity = {
      name: coerceConfigValue(name, 'Name'),
      email: coerceConfigValue(email, 'Email'),
    }
    execFileSync('git', ['config', '--global', 'user.name', identity.name], { env: getCliEnv(), timeout: PROBE_TIMEOUT_MS })
    execFileSync('git', ['config', '--global', 'user.email', identity.email], { env: getCliEnv(), timeout: PROBE_TIMEOUT_MS })
    return identity
  })

  server.register('setupCheckSshAccess', (args): SetupSshAccessResult => {
    const [request] = args
    const { host } = z.object({ host: z.string().optional() }).strict().parse(request)
    const target = host?.trim() || 'github.com'
    if (!isValidCloneHost(target)) throw new Error('That is not a valid host name.')

    // A code host answers the shell request with a greeting and a non-zero exit,
    // so the greeting — not the exit code — is what says the key is accepted.
    let output = ''
    try {
      output = execFileSync('ssh', [
        ...sshConnectionOptions(),
        '-T', `git@${target}`,
      ], { encoding: 'utf8', env: getCliEnv(), timeout: SSH_COMMAND_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] })
      return { host: target, ok: true, message: output.trim() || `Connected to ${target}.` }
    } catch (err) {
      // SAFETY: Node adds captured stdout and stderr to the Error thrown by execFileSync.
      const failure = err as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string }
      output = [failure.stdout, failure.stderr].map((part) => part?.toString() ?? '').join('\n').trim()
      const ok = /successfully authenticated/i.test(output)
      return { host: target, ok, message: output || failure.message || `Couldn’t reach ${target} over SSH.` }
    }
  })

  server.register('setupAuthorizeGhCli', async () => {
    const token = safeLoadGithubToken()
    if (!token) throw new Error('Connect GitHub on this host before authorizing the gh CLI.')
    if (!hasCommand('gh')) throw new Error('The GitHub CLI (gh) is not installed on this host.')
    if (!hasGithubCliScopes(parseGithubScopes(token.scope))) {
      throw new Error('Reconnect GitHub on this host to grant the scopes required by the gh CLI.')
    }

    // `--with-token` reads stdin, so the token never becomes an argument.
    execFileSync('gh', ['auth', 'login', '--with-token'], {
      input: `${token.accessToken}\n`,
      env: getCliEnv(),
      timeout: GH_AUTH_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { ok: true } as const
  })

  server.register('setupInstallGitCredentialHelper', () => {
    const solusPath = resolveSolusCli()
    if (!solusPath) throw new Error('The Solus CLI was not found on this host, so git has nothing to ask for credentials.')
    // The leading "!" makes git run this as a shell command rather than looking
    // for a `git-credential-<name>` binary — so the path has to survive a shell.
    execFileSync('git', ['config', '--global', GITHUB_CREDENTIAL_KEY, `!'${solusPath}' git-credential`], {
      env: getCliEnv(),
      timeout: PROBE_TIMEOUT_MS,
    })
    return { ok: true } as const
  })

  server.register('setupPrepareProject', async (args, ctx): Promise<SetupPrepareProjectResult> => {
    // The device is the key the checkout path and the delegated token are both
    // stored and read back under.
    const deviceId = requireDeviceScopedSetupContext(ctx)
    const [request] = args
    const { cloneUrl, credential: rawCredential, worktreePath, baseBranch } = setupPrepareProjectSchema.parse(request)
    const credential = coerceDelegatedCredential(rawCredential)
    const parsed = validateCloneUrl(cloneUrl)
    const repoKey = cloneRepoKey(parsed.cloneUrl)
    if (!repoKey) throw new Error('The clone URL must name both an owner and repository.')

    const checkoutPath = dispatchCheckoutPath(projectsRootOf(ctx), deviceId, repoKey)
    if (runProbe('git', ['-C', checkoutPath, 'rev-parse', '--show-toplevel'])) {
      const result = await server.handle('setupAdoptProject', [{ path: checkoutPath, cloneUrl: parsed.cloneUrl }], ctx)
      if (credential) {
        configureDelegatedCheckout(checkoutPath, deviceId, credential)
      }
      const path = baseBranch
        ? (await ensureBranchWorktree(checkoutPath, baseBranch)).worktreePath!
        : resolveDispatchWorktree(checkoutPath, worktreePath)
      return { ...result, path, action: 'updated' }
    }

    const cloneRequest = {
      cloneUrl: parsed.cloneUrl,
      destination: checkoutPath,
    }
    if (credential) Object.assign(cloneRequest, { credential })
    const result = await server.handle('setupCloneProject', [cloneRequest], ctx)
    if (credential) {
      configureDelegatedCheckout(result.path, deviceId, credential)
    }
    const path = baseBranch
      ? (await ensureBranchWorktree(result.path, baseBranch)).worktreePath!
      : resolveDispatchWorktree(result.path, worktreePath)
    return {
      path,
      projectKey: result.projectKey,
      action: 'cloned',
    }
  })

  server.register('setupCloneProject', async (args, ctx): Promise<SetupCloneProjectResult> => {
    const { emitStatus, emitLog } = eventSink(ctx.clientId)
    const [request] = args
    const { cloneUrl, name, destination, protocol, clean, credential: rawCredential } = setupCloneProjectSchema.parse(request)
    const credential = coerceDelegatedCredential(rawCredential)
    const parsed = validateCloneUrl(cloneUrl)
    const selectedProtocol = coerceCloneProtocol(protocol)
    const cloneUrls = credential
      ? [applyCloneProtocol(parsed.cloneUrl, 'https')]
      : selectedProtocol
      ? [applyCloneProtocol(parsed.cloneUrl, selectedProtocol)]
      : [
          applyCloneProtocol(parsed.cloneUrl, 'ssh'),
          applyCloneProtocol(parsed.cloneUrl, 'https'),
        ]
    const step: SetupStreamStep = 'clone'

    return runExclusive(step, async () => {
      const hostProjectsRoot = projectsRootOf(ctx)
      // Only a directory this host's own clone left behind can be removed, so a
      // stray `clean` can never delete a folder the user chose. It runs before the
      // destination resolves: a retry that names no destination must land back on
      // the original path, not beside the partial under a "-2" suffix.
      if (clean === true && lastFailedCloneDestination) {
        await rm(lastFailedCloneDestination, { recursive: true, force: true })
        lastFailedCloneDestination = null
      }
      const targetPath = resolveCloneDestination({
        destination: destination?.trim() ? expandHome(destination.trim()) : undefined,
        name,
        repoName: parsed.repoName,
        projectsRoot: hostProjectsRoot,
      })
      await assertEmptyDestination(targetPath)
      const targetExistedBeforeClone = existsSync(targetPath)

      const parent = dirname(targetPath)
      await mkdir(parent, { recursive: true })
      let auth: CloneAuth | null = null

      for (const [index, attemptUrl] of cloneUrls.entries()) {
        const isHttps = attemptUrl.startsWith('https://')
        const attemptParts = parseCloneUrlParts(attemptUrl)
        const token = credential ?? (
          isHttps && attemptParts?.host.toLowerCase() === 'github.com'
            ? safeLoadGithubToken(loadStoredGithubToken)
            : null
        )
        const askpass = token ? await createGitAskpassHelper() : null
        try {
          auth = await attemptClone({
            step,
            attemptUrl,
            parent,
            targetPath,
            isHttps,
            token,
            askpass,
            spawnProcess,
            emitStatus,
            emitLog,
            emitFailureStatus: index === cloneUrls.length - 1,
          })
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

  function configureDelegatedCheckout(
    checkoutPath: string,
    deviceId: string,
    credential: GithubDelegatedCredential,
  ): void {
    saveDelegation(deviceId, credential)
    const solusPath = resolveSolusCli()
    if (!solusPath) throw new Error('The Solus CLI was not found on this host, so git has nothing to ask for credentials.')
    const config = (key: string, value: string) => execFileSync(
      'git',
      ['-C', checkoutPath, 'config', '--local', key, value],
      { env: getCliEnv(), timeout: PROBE_TIMEOUT_MS },
    )
    // Local config is shared by linked worktrees, so every dispatched worktree inherits the caller's identity and helper.
    config(GITHUB_CREDENTIAL_KEY, `!'${solusPath}' git-credential --delegation ${deviceId}`)
    config('user.name', credential.login)
    config('user.email', `${credential.login}@users.noreply.github.com`)
  }

  server.register('setupSyncProject', async (args): Promise<SetupAdoptProjectResult> => {
    const [request] = args
    const { path, cloneUrl } = setupSyncProjectSchema.parse(request)
    const rawPath = path.trim()
    if (!rawPath) throw new Error('A checkout path is required.')
    const checkoutPath = expandHome(rawPath)
    const expected = cloneRepoKey(validateCloneUrl(cloneUrl).cloneUrl)
    const origin = runProbe('git', ['-C', checkoutPath, 'config', '--get', 'remote.origin.url'])
    const actual = origin ? cloneRepoKey(origin) : null
    if (!runProbe('git', ['-C', checkoutPath, 'rev-parse', '--show-toplevel'])) {
      throw new Error(`There’s no git checkout at ${checkoutPath}.`)
    }
    if (!expected || !actual || actual !== expected) {
      throw new Error(`The git checkout at ${checkoutPath} does not match ${expected ?? 'the selected repository'}.`)
    }

    try {
      // Dispatch must never create a surprise merge on an unattended host.
      // Fast-forward updates are automatic; dirty, divergent, or conflicted
      // checkouts stop here with Git's own actionable error.
      await runAsync('git', ['pull', '--ff-only'], checkoutPath, {
        timeout: 120_000,
        env: { GIT_TERMINAL_PROMPT: '0' },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Couldn’t update ${checkoutPath}: ${message}`)
    }
    return { path: checkoutPath, projectKey: await registerProject(checkoutPath) }
  })

  server.register('setupAdoptProject', async (args): Promise<SetupAdoptProjectResult> => {
    const [request] = args
    const { path, cloneUrl } = setupAdoptProjectSchema.parse(request)
    const rawPath = path.trim()
    if (!rawPath) throw new Error('A checkout path is required.')
    const checkoutPath = expandHome(rawPath)
    const checkoutRoot = runProbe('git', ['-C', checkoutPath, 'rev-parse', '--show-toplevel'])
    if (!checkoutRoot) throw new Error(`There’s no git checkout at ${checkoutPath}.`)

    if (cloneUrl?.trim()) {
      const expected = cloneRepoKey(validateCloneUrl(cloneUrl).cloneUrl)
      if (!expected) throw new Error('The clone URL must name both an owner and repository.')
      const origin = runProbe('git', ['-C', checkoutPath, 'config', '--get', 'remote.origin.url'])
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
    deps.assertNewWorkAllowed?.()
    if (activeSteps.has(step)) throw new Error(`Setup step "${step}" is already running.`)
    activeSteps.add(step)
    deps.onActiveStepsChanged?.(activeSteps.size)
    try {
      return await task()
    } finally {
      activeSteps.delete(step)
      deps.onActiveStepsChanged?.(activeSteps.size)
    }
  }

}

function installStepForAgent(agent: SetupAgent): SetupStreamStep {
  return agent === 'claude' ? 'install-claude' : 'install-codex'
}

/** Readiness cares only about "can this host run the agent", so an unknown auth probe reads as not signed in. */
function agentReadiness(agent: SetupAgent, deps: AgentAuthProbeDeps = {}): HostReadiness['agents'][SetupAgent] {
  const check = checkAgentAuth(agent, deps)
  return { installed: check.installed, signedIn: check.installed && check.authenticated === true }
}

function checkAgentAuth(agent: SetupAgent, deps: AgentAuthProbeDeps = {}): SetupAgentAuthCheckResult {
  const resolveBinary = deps.resolveAgentBinary ?? whichAgentBinary
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
 * Only the dispatch handlers need a device: a checkout belongs to the paired
 * device that asked for it (ADR-0011), so without one there is no path to write
 * to. The rest of setup does not — reaching a handler at all already means the
 * socket was admitted, and the handshake admits nobody the bind policy has not
 * already trusted. A loopback or trusted-network client connects tokenless by
 * design, so a blanket device check here rejects exactly the clients the policy
 * meant to let in.
 */
function requireDeviceScopedSetupContext(ctx: HandlerCtx): string {
  if (!ctx.deviceId) throw new Error('Dispatch checkouts require a paired device. Pair this client with the host, then try again.')
  return ctx.deviceId
}

function coerceCloneProtocol(value: CloneProtocol | undefined): CloneProtocol | undefined {
  return value
}

function coerceDelegatedCredential(value: GithubDelegatedCredential | undefined): GithubDelegatedCredential | undefined {
  if (!value) return undefined
  const { accessToken, login } = value
  const normalized = { accessToken: accessToken.trim(), login: login.trim() }
  return normalized.accessToken && normalized.login ? normalized : undefined
}

/** Git config values reach a shell-free execFile, but newlines would still corrupt the config file. */
function coerceConfigValue(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} is required.`)
  if (trimmed.length > 200 || [...trimmed].some((character) => character === '\r' || character === '\n' || character === '\0')) {
    throw new Error(`${label} contains characters git can’t store.`)
  }
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

async function attemptClone(opts: {
  step: SetupStreamStep
  attemptUrl: string
  parent: string
  targetPath: string
  isHttps: boolean
  token: { accessToken: string } | null
  askpass: { path: string } | null
  spawnProcess: SpawnProcess
  emitStatus(event: SetupStatusEvent): void
  emitLog(event: SetupLogEvent): void
  emitFailureStatus: boolean
}): Promise<CloneAuth> {
  const {
    step, attemptUrl, parent, targetPath, isHttps, token, askpass,
    spawnProcess, emitStatus, emitLog, emitFailureStatus,
  } = opts
  // Cloning into a basename from the parent keeps git's counting/receiving
  // lines on the stream; a full destination path suppresses them.
  const spec: ProcessCommandSpec = {
    command: 'git',
    args: ['clone', '--progress', attemptUrl, basename(targetPath)],
    display: `git clone --progress ${attemptUrl} ${basename(targetPath)}`,
  }
  const env = gitAuthEnv({
    isHttps,
    token: token?.accessToken ?? null,
    askpassPath: askpass?.path ?? null,
  })
  emitLog({ step, line: `Cloning ${attemptUrl} into ${targetPath}` })
  await runSetupProcess({
    step,
    spec,
    spawnProcess,
    emitStatus,
    emitLog,
    cwd: parent,
    emitFailureStatus,
    env,
  })
  return isHttps ? (token ? 'token' : 'anonymous') : 'ssh'
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
  env?: GitAuthEnv
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
    emitFailureStatus = true,
    verifySuccess,
  } = opts
  emitStatus({ step, status: 'running' })

  const child = spawnProcess(spec.command, spec.args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: getCliEnv({ FORCE_COLOR: '0', ...env }),
  })

  let settled = false
  const outputTail: string[] = []
  const emitOutputLine = (line: string) => {
    emitLog({ step, line })
    if (!line.trim()) return
    outputTail.push(line)
    if (outputTail.length > 3) outputTail.shift()
  }
  const stdout = createLineBuffer(emitOutputLine)
  const stderr = createLineBuffer(emitOutputLine)
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
      else {
        const detail = outputTail.length > 0 ? `:\n${outputTail.join('\n')}` : ''
        finish('failed', `Exited with code ${code ?? 'unknown'}${detail}`)
      }
    })
  })
}

function createLineBuffer(onLine: (line: string) => void): LineBuffer {
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
