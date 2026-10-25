import { execFile, execFileSync, spawn as nodeSpawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, readdirSync } from 'fs'
import { mkdir, readdir, rm } from 'fs/promises'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import { z } from 'zod'
import { AGENT_BIN, type AgentId, type CloneAuth, type CloneProtocol, type DispatchHistoryRoot, type GitCommitIdentity, type GithubDelegatedCredential, type HostCapabilities, type HostReadiness, type SetupAdoptProjectResult, type SetupAgent, type SetupAgentAuthCheckResult, type SetupCloneProjectRequest, type SetupCloneProjectResult, type SetupGithubRepo, type SetupGithubReposResult, type SetupLogEvent, type SetupSshAccessResult, type SetupStatusEvent, type SetupStepResult, type SetupStreamStep } from '@solus/contracts/types'
import { providerLoginConnected, type LoginProbe } from '../../execution/seats/seat-login'
import type { SeatStore } from '../../execution/seats/seat-manager'
import { seatFor } from '../../admission/actor'
import type { SeatProvider } from '@solus/contracts/seats'
import { GithubConnectionRequiredError } from '../../providers/github/connection-required'
import { usesAccountIntegration } from '../../vault/vault'
import type { SolusServer, HandlerCtx } from '../server'
import type { Principal } from '../../admission/principal'
import type { HostEventPublisher } from '../events/host-event-publisher'
import type { DispatchCheckoutPathOf, PrepareDispatchCheckout, RepositoryProgress } from '../../execution/sessions/dispatch-repository'
import { findOnPath, launchedProcess, launchProcess, warmCliPath } from '../../cli-env'
import { runAsync } from '../../git/exec'
import { withBareRepositoryGuard } from '../../git/bare-repository-guard'
import { isGitUsable } from '../../git/git-availability'
import { gitCommandAuth } from '../../git/git-auth-env'
import { currentIdentity } from '../../vault/acting-scope'
import { githubCredentials, type GithubStoredToken } from '../../providers/github/credentials'
import { buildClient } from '../../providers/github/octokit'
import { hasGithubCliScopes, parseGithubScopes } from '@solus/contracts/github-auth'
import { PARAKEET_MODEL_DIR } from '../../model-downloader'
import { getServerSettings, setProjectsBaseDirectory } from '../../host/settings'
import { projectsRootFor, setupProjectsRoot } from '../../workspace'
import { listProjects, recordProject } from '../../project-config/projects-manifest'
import { resolveProjectKey } from '../../project-config/project-config'
import { expandHome } from '../../files/host-path'
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
import { safeProjectDirName } from '@solus/contracts/project-folder-name'
import { initRepository } from '../../git/git-init'
import { getDefaultBranch } from '../../git/worktree-manager'
import { GITHUB_CREDENTIAL_KEY, solusGitHelper } from '../../providers/github/git-credential'
import { dispatchCheckoutOwnerKey, dispatchCheckoutPath, resolveDispatchHistoryRoots, resolveDispatchWorktree } from '../../project-config/dispatch-checkouts'
import type { CheckoutService } from '../../git/checkout-service'
import { PARTIAL_CLONE_ARGS, ensureFullHistory } from '../../git/partial-clone'
import { hostFileManager } from '../../platform/file-manager'

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const MAX_SETUP_LOG_LINES = 1_000
/** Probes must never hang the readiness rail; nothing here talks to the network. */
const PROBE_TIMEOUT_MS = 2_000
const SSH_COMMAND_TIMEOUT_MS = 10_000
const GH_AUTH_TIMEOUT_MS = 10_000
const MAX_DISPATCH_HISTORY_REPO_KEYS = 32

const setupAgentSchema = z.enum(['claude', 'codex'])
const delegatedCredentialSchema = z.object({
  accessToken: z.string(),
  login: z.string(),
}).strict()
const setupAgentRequestSchema = z.object({ agent: setupAgentSchema }).strict()
const dispatchRepositorySchema = z.object({
  cloneUrl: z.string(),
  credential: delegatedCredentialSchema.optional(),
  worktreePath: z.string().trim().min(1).optional(),
  baseBranch: z.string().trim().min(1).optional(),
  newWorktree: z.boolean().optional(),
}).strict()
const setupCloneProjectSchema = z.object({
  cloneUrl: z.string(),
  name: z.string().optional(),
  destination: z.string().optional(),
  protocol: z.enum(['https', 'ssh']).optional(),
  clean: z.boolean().optional(),
  credential: delegatedCredentialSchema.optional(),
  partialClone: z.boolean().optional(),
}).strict()
const setupSyncProjectSchema = z.object({
  path: z.string(),
  cloneUrl: z.string(),
}).strict()
const setupAdoptProjectSchema = z.object({
  path: z.string(),
  cloneUrl: z.string().optional(),
}).strict()
const setupCreateProjectSchema = z.object({
  name: z.string().trim().min(1, 'Name the project.'),
  parent: z.string().trim().min(1).optional(),
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
  checkouts?: CheckoutService
  events?: HostEventPublisher
  spawnProcess?: SpawnProcess
  hasCommand?: (command: string) => boolean
  loadGithubToken?: () => Promise<GithubStoredToken | null>
  registerProject?: (path: string) => Promise<string>
  projectsRoot?: () => string
  assertNewWorkAllowed?: () => void
  onActiveStepsChanged?: (count: number) => void
  onProviderInstalled?: (agent: SetupAgent) => Promise<void>
  /**
   * The caller's own provider seat answers "signed in" (provider-seats.md): a member
   * of a managed host signs in to their seat, never to the host login.
   */
  seats?: Pick<SeatStore, 'status'>
}

export interface AgentAuthProbeDeps {
  resolveAgentBinary?: typeof whichAgentBinary
  hasClaudeAuth?: () => Promise<boolean>
  hasCodexAuth?: () => Promise<boolean>
}

/** The capability fields a host learns by probing itself; the handler list adds the rest. */
export type ProbedHostCapabilities = Required<Pick<HostCapabilities,
  'headless' | 'desktopHandlers' | 'agents' | 'dictation' | 'platform' | 'version' | 'projectCount' | 'agentAuth' | 'gitAuth'>>
  & Pick<HostCapabilities, 'projectsBaseDirectory' | 'projectsBaseDirectoryIsSet' | 'fileManager'>

export interface CapabilityProbeOptions {
  headless: boolean
  desktopHandlers: boolean
  version: string
  /** Who is asking: a member's pickers open on their own member folder (managed-hosts.md §3). */
  principal?: Principal
}

export async function probeHostCapabilities(opts: CapabilityProbeOptions): Promise<ProbedHostCapabilities> {
  const projects = projectsVisibleTo(opts.principal, await listProjects().catch(() => []))
  return {
    headless: opts.headless,
    desktopHandlers: opts.desktopHandlers,
    agents: {
      claude: !!await whichAgentBinary('claude-code'),
      codex: !!await whichAgentBinary('codex'),
    },
    dictation: existsSync(join(PARAKEET_MODEL_DIR, '.installed')),
    platform: process.platform,
    fileManager: await hostFileManager(),
    version: opts.version,
    projectCount: projects.length,
    agentAuth: {
      claude: await hasClaudeAuth(),
    },
    gitAuth: {
      github: await hasGithubAuth(),
    },
    ...projectsBaseDirectoryFor(opts.principal),
  }
}

/** Capability probes intentionally skip the launcher's cache. Off the main
 *  thread: the capability read is the renderer's first request, and a spawn
 *  that blocks here holds the first transcript page behind it. */
function whichAgentBinary(agentId: AgentId): Promise<string | null> {
  const bin = AGENT_BIN[agentId]
  if (!bin) return Promise.resolve(null)
  // Windows has no `which`, and no member runs as another user there.
  if (process.platform === 'win32') return warmCliPath().then((path) => findOnPath(bin, path))
  return new Promise((resolve) => {
    const run = launchProcess('which', [bin])
    execFile(run.file, run.args, { encoding: 'utf8', env: run.env, timeout: 3000 }, (error, stdout) => {
      resolve(error ? null : stdout.trim() || null)
    })
  })
}

/** The host login is the owner's seat: the seat module owns the one honest probe for it. */
export function hasClaudeAuth(succeeds?: LoginProbe): Promise<boolean> {
  return providerLoginConnected('claude-code', null, succeeds)
}

export function hasCodexAuth(): Promise<boolean> {
  return providerLoginConnected('codex', null)
}

export async function hasGithubAuth(): Promise<boolean> {
  return !!(await safeLoadGithubToken())
}

/**
 * Everything the "New project" dialog needs to decide whether a host can clone
 * and then push. Nothing here touches the network, so it stays cheap enough to
 * run every time the dialog opens.
 */
export async function probeHostReadiness(
  hasCommand: (command: string) => boolean = commandExists,
  agentDeps: AgentAuthProbeDeps = {},
  projectsRoot: string = setupProjectsRoot(),
): Promise<HostReadiness> {
  // Checked again on each probe: the user opens this after an install. Without
  // git, the git config probes are not run, because the macOS stub would open
  // the "Install developer tools" dialog for each one.
  const gitInstalled = isGitUsable({ recheck: true })
  const token = await safeLoadGithubToken()
  const ghCli = hasCommand('gh')
  return {
    platform: process.platform,
    home: homedir(),
    projectsRoot,
    git: {
      installed: gitInstalled,
      identity: gitInstalled ? readGitIdentity() : null,
      credentialHelper: gitInstalled && !!runProbe('git', ['config', '--global', '--get', GITHUB_CREDENTIAL_KEY]),
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
      claude: await agentReadiness('claude', agentDeps),
      codex: await agentReadiness('codex', agentDeps),
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
 * The projects folder as this principal's pickers and Settings see it: the
 * folder in use, never the raw setting, so a cloud member reads their own
 * `/data/projects/<their name>` and an unset host reads `~/projects`. The folder is
 * created here because this is how a client first learns of it, and a picker
 * that opens on a missing folder shows an error instead of a place.
 */
export function projectsBaseDirectoryFor(
  principal: Principal | undefined,
): Pick<HostCapabilities, 'projectsBaseDirectory' | 'projectsBaseDirectoryIsSet'> {
  const root = projectsRootFor(principal)
  // Best effort: an unwritable root still reports, and the picker says why.
  try { mkdirSync(root, { recursive: true }) } catch {}
  return {
    projectsBaseDirectory: root,
    projectsBaseDirectoryIsSet: principal?.kind !== 'org-member' && !!getServerSettings().projectsBaseDirectory,
  }
}

/**
 * The projects a listing shows this principal: a member sees their own member
 * folder only, so another person's checkout is never offered as theirs to open;
 * the owner and the host itself see every project.
 */
export function projectsVisibleTo<T extends { path: string }>(principal: Principal | undefined, projects: T[], hostRoot = setupProjectsRoot()): T[] {
  if (principal?.kind !== 'org-member') return projects
  const memberFolder = projectsRootFor(principal, hostRoot)
  return projects.filter((project) => {
    const inside = relative(memberFolder, resolve(project.path))
    return inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))
  })
}

/** What the setup domain lends the rest of the host. */
export interface SetupDomain {
  /** A Run on send's repository, made ready before its run starts (docs/run-on.md). */
  prepareDispatchCheckout: PrepareDispatchCheckout
  /** The folder `prepareDispatchCheckout` copies to, known before the copy. */
  dispatchCheckoutPathOf: DispatchCheckoutPathOf
}

export function registerSetupHandlers(server: SolusServer, deps: SetupHandlerDeps): SetupDomain {
  const checkouts = deps.checkouts
  const spawnProcess = deps.spawnProcess ?? nodeSpawn
  const hasCommand = deps.hasCommand ?? commandExists
  const loadStoredGithubToken = deps.loadGithubToken ?? (() => githubCredentials().accountToken())
  const projectsRoot = deps.projectsRoot ?? setupProjectsRoot
  /** The caller's own member folder beneath the host root (managed-hosts.md §3). */
  const projectsRootOf = (ctx: HandlerCtx) => projectsRootFor(ctx.principal, projectsRoot())
  /** The last step of both cloning and adopting; returns the key both promise. */
  const registerProject = deps.registerProject ?? (async (path: string) => {
    await recordProject(path)
    return resolveProjectKey(path)
  })
  /** The auth probes for the caller: their seat when the host has seats, else the host login. */
  const agentDepsFor = (ctx: HandlerCtx): AgentAuthProbeDeps => {
    const seats = deps.seats
    if (!seats) return deps
    const seat = seatFor(ctx.actor)
    const connected = async (provider: SeatProvider) => (await seats.status(seat, provider)).state === 'connected'
    return { ...deps, hasClaudeAuth: () => connected('claude-code'), hasCodexAuth: () => connected('codex') }
  }
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
    const ownerKey = dispatchCheckoutOwnerKey(ctx.principal, requireDispatchDevice(ctx.deviceId))
    const [requestRepoKeys] = args
    const repoKeys = z.array(z.string()).parse(requestRepoKeys)
    if (repoKeys.length > MAX_DISPATCH_HISTORY_REPO_KEYS) {
      throw new Error(`Dispatch history is limited to ${MAX_DISPATCH_HISTORY_REPO_KEYS} repositories per request.`)
    }
    return resolveDispatchHistoryRoots(projectsRootOf(ctx), ownerKey, repoKeys)
  })

  server.register('setProjectsBaseDirectory', (args, ctx) => {
    const [path] = args
    setProjectsBaseDirectory(z.string().parse(path))
    return projectsBaseDirectoryFor(ctx.principal)
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

  server.register('setupCheckAgentAuth', (args, ctx): Promise<SetupAgentAuthCheckResult> => {
    const [request] = args
    const { agent: setupAgent } = setupAgentRequestSchema.parse(request)
    return checkAgentAuth(setupAgent, agentDepsFor(ctx))
  })

  // Signing an agent in is the seat connect (`seatConnectStart` and friends): the
  // host login is the owner's seat, so the wizard and a member's row share one relay.

  server.register('setupListGithubRepos', async (): Promise<SetupGithubReposResult> => {
    if (!(await hasGithubAuth())) return { connected: false }

    const client = await buildClient(githubCredentials())
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

  server.register('setupHostReadiness', async (_args, ctx): Promise<HostReadiness> => {
    const [readiness, github] = await Promise.all([
      probeHostReadiness(hasCommand, agentDepsFor(ctx), projectsRootOf(ctx)),
      currentIdentity().github(),
    ])
    if (!github) return readiness
    // A member commits as their own GitHub account, never as the host's global config.
    const memberIdentity = github.kind === 'connected' ? { name: github.login, email: `${github.login}@users.noreply.github.com` } : null
    return { ...readiness, git: { ...readiness.git, identity: memberIdentity } }
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
    for (const [key, value] of [['user.name', identity.name], ['user.email', identity.email]]) {
      const run = launchProcess('git', withBareRepositoryGuard('git', ['config', '--global', key, value]))
      execFileSync(run.file, run.args, { env: run.env, timeout: PROBE_TIMEOUT_MS })
    }
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
      const run = launchProcess('ssh', [...sshConnectionOptions(), '-T', `git@${target}`])
      output = execFileSync(run.file, run.args, { encoding: 'utf8', env: run.env, timeout: SSH_COMMAND_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] })
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
    const token = await safeLoadGithubToken()
    if (!token) throw new Error('Connect GitHub on this host before authorizing the gh CLI.')
    if (!hasCommand('gh')) throw new Error('The GitHub CLI (gh) is not installed on this host.')
    if (!hasGithubCliScopes(parseGithubScopes(token.scope))) {
      throw new Error('Reconnect GitHub on this host to grant the scopes required by the gh CLI.')
    }

    // `--with-token` reads stdin, so the token never becomes an argument.
    const run = launchProcess('gh', ['auth', 'login', '--with-token'])
    execFileSync(run.file, run.args, {
      input: `${token.accessToken}\n`,
      env: run.env,
      timeout: GH_AUTH_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { ok: true } as const
  })

  server.register('setupInstallGitCredentialHelper', () => {
    const helper = solusGitHelper([])
    if (!helper) throw new Error('The Solus CLI was not found on this host, so git has nothing to ask for credentials.')
    const run = launchProcess('git', withBareRepositoryGuard('git', ['config', '--global', GITHUB_CREDENTIAL_KEY, helper]))
    execFileSync(run.file, run.args, {
      env: run.env,
      timeout: PROBE_TIMEOUT_MS,
    })
    return { ok: true } as const
  })

  /**
   * The one place a dispatch checkout's folder is decided: the caller's projects
   * folder, their owner key, and the repository. Turn admission reads it before
   * the copy, and the copy writes to it, so the two cannot disagree.
   */
  const dispatchCheckoutPathOf: DispatchCheckoutPathOf = (repository, caller) => {
    // The owner key is the key the checkout path and the delegated token are both
    // stored and read back under: the device, or the member on a managed host.
    const ownerKey = dispatchCheckoutOwnerKey(caller.principal, requireDispatchDevice(caller.deviceId))
    const repoKey = cloneRepoKey(validateCloneUrl(dispatchRepositorySchema.parse(repository).cloneUrl).cloneUrl)
    if (!repoKey) throw new Error('The clone URL must name both an owner and repository.')
    return dispatchCheckoutPath(projectsRootFor(caller.principal, projectsRoot()), ownerKey, repoKey)
  }

  /**
   * The caller's dispatch checkout of a repository, made ready for a run: the
   * checkout they have, or a new partial clone. Answers the folder the run
   * starts in. The prompt that carries the repository was admitted already.
   */
  const prepareDispatchCheckout: PrepareDispatchCheckout = async (repository, caller, progress) => {
    const checkoutPath = dispatchCheckoutPathOf(repository, caller)
    const ownerKey = dispatchCheckoutOwnerKey(caller.principal, requireDispatchDevice(caller.deviceId))
    const { cloneUrl, credential: rawCredential, worktreePath, baseBranch, newWorktree } = dispatchRepositorySchema.parse(repository)
    if (!worktreePath && !newWorktree && !checkouts) throw new Error('The checkout service is not available')
    const credential = coerceDelegatedCredential(rawCredential)
    const parsed = validateCloneUrl(cloneUrl)

    // Only the host's own work keeps an identity in checkout config (the paired
    // device's helper and author); a member's processes act from their own home.
    const configure = (path: string) => {
      if (credential && currentIdentity().isHost) configureDelegatedCheckout(path, ownerKey, credential)
    }
    const prepare = async (path: string): Promise<string> => {
      // A checkout cloned with `--depth=1` before partial clones gets its full history once, here.
      await ensureFullHistory(path)
      if (worktreePath) return resolveDispatchWorktree(path, worktreePath)
      // A new worktree is made from the repository, whatever branch the checkout holds.
      if (newWorktree) return path
      // A dispatch that names no branch works on the default branch: in the
      // checkout when it holds that branch, else where the branch is held.
      const branch = baseBranch ?? await getDefaultBranch(path)
      return (await checkouts!.ensureBranch(path, branch)).worktreePath ?? path
    }

    if (runProbe('git', ['-C', checkoutPath, 'rev-parse', '--show-toplevel'])) {
      await adoptProject(checkoutPath, parsed.cloneUrl)
      configure(checkoutPath)
      return prepare(checkoutPath)
    }

    const cloneRequest = {
      cloneUrl: parsed.cloneUrl,
      destination: checkoutPath,
      partialClone: true,
    }
    if (credential) Object.assign(cloneRequest, { credential })
    const sink = {
      emitStatus: () => {},
      emitLog: (event: SetupLogEvent) => progress.onOutput(event.line, false),
    }
    const result = await cloneProject(cloneRequest, projectsRootFor(caller.principal, projectsRoot()), sink, progress)
    configure(result.path)
    return prepare(result.path)
  }

  server.register('setupCloneProject', (args, ctx): Promise<SetupCloneProjectResult> => {
    const [request] = args
    return cloneProject(request, projectsRootOf(ctx), eventSink(ctx.clientId))
  })

  /** A clone into the caller's projects folder, or into the destination it names.
   *  `progress` takes git's transfer lines and can stop the clone. */
  async function cloneProject(
    request: SetupCloneProjectRequest,
    hostProjectsRoot: string,
    sink: { emitStatus(event: SetupStatusEvent): void; emitLog(event: SetupLogEvent): void },
    progress?: RepositoryProgress,
  ): Promise<SetupCloneProjectResult> {
    const { emitStatus, emitLog } = sink
    const { cloneUrl, name, destination, protocol, clean, credential: rawCredential, partialClone } = setupCloneProjectSchema.parse(request)
    const credential = coerceDelegatedCredential(rawCredential)
    const parsed = validateCloneUrl(cloneUrl)
    const selectedProtocol = coerceCloneProtocol(protocol)
    // A member clones from their own home: over HTTPS, with their own connection.
    const actsAsMember = !currentIdentity().isHost
    const cloneUrls = credential || actsAsMember
      ? [applyCloneProtocol(parsed.cloneUrl, 'https')]
      : selectedProtocol
      ? [applyCloneProtocol(parsed.cloneUrl, selectedProtocol)]
      : [
          applyCloneProtocol(parsed.cloneUrl, 'ssh'),
          applyCloneProtocol(parsed.cloneUrl, 'https'),
        ]
    const step: SetupStreamStep = 'clone'

    return runExclusive(step, async () => {
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
      // A GitHub clone over HTTPS that had no token to offer: on a host that
      // clones with the account's connection, that is the likely cause.
      let githubAttemptWithoutToken = false

      for (const [index, attemptUrl] of cloneUrls.entries()) {
        const isHttps = attemptUrl.startsWith('https://')
        const attemptParts = parseCloneUrlParts(attemptUrl)
        const isGithubHttps = isHttps && attemptParts?.host.toLowerCase() === 'github.com'
        const token = credential ?? (
          isGithubHttps
            ? await safeLoadGithubToken(loadStoredGithubToken)
            : null
        )
        if (isGithubHttps && !token) githubAttemptWithoutToken = true
        try {
          auth = await attemptClone({
            step,
            attemptUrl,
            parent,
            targetPath,
            isHttps,
            token,
            partialClone: partialClone === true,
            spawnProcess,
            emitStatus,
            emitLog,
            emitFailureStatus: index === cloneUrls.length - 1,
            progress,
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
            if (githubAttemptWithoutToken && usesAccountIntegration()) throw new GithubConnectionRequiredError()
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
        }
      }

      if (!auth) throw new Error('Clone failed without an authentication result.')
      lastFailedCloneDestination = null
      return { path: targetPath, projectKey: await registerProject(targetPath), auth }
    })
  }

  function configureDelegatedCheckout(
    checkoutPath: string,
    ownerKey: string,
    credential: GithubDelegatedCredential,
  ): void {
    githubCredentials().delegate(ownerKey, credential)
    const helper = solusGitHelper(['--delegation', ownerKey])
    if (!helper) throw new Error('The Solus CLI was not found on this host, so git has nothing to ask for credentials.')
    const config = (key: string, value: string) => {
      const run = launchProcess('git', withBareRepositoryGuard('git', ['-C', checkoutPath, 'config', '--local', key, value]))
      execFileSync(run.file, run.args, { env: run.env, timeout: PROBE_TIMEOUT_MS })
    }
    // Local config is shared by linked worktrees, so every dispatched worktree inherits the caller's identity and helper.
    config(GITHUB_CREDENTIAL_KEY, helper)
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
      await runAsync('git', ['pull', '--ff-only'], checkoutPath, { timeout: 120_000, env: { GIT_TERMINAL_PROMPT: '0' } })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Couldn’t update ${checkoutPath}: ${message}`)
    }
    return { path: checkoutPath, projectKey: await registerProject(checkoutPath) }
  })

  server.register('setupAdoptProject', (args): Promise<SetupAdoptProjectResult> => {
    const [request] = args
    const { path, cloneUrl } = setupAdoptProjectSchema.parse(request)
    return adoptProject(path, cloneUrl)
  })

  /** Record a checkout the host already has, refusing one whose origin is another repository. */
  async function adoptProject(path: string, cloneUrl: string | undefined): Promise<SetupAdoptProjectResult> {
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
  }

  /**
   * A project from nothing: an empty folder in the caller's projects root (or the
   * parent they chose), a git repository in it, and the project recorded. A name
   * already taken is refused rather than suffixed — the user typed it.
   */
  server.register('setupCreateProject', async (args, ctx): Promise<SetupAdoptProjectResult> => {
    const [request] = args
    const { name, parent } = setupCreateProjectSchema.parse(request)
    const projectPath = join(parent ? expandHome(parent) : projectsRootOf(ctx), safeProjectDirName(name))
    if (existsSync(projectPath)) throw new Error(`${projectPath} already exists. Choose another name.`)
    await mkdir(projectPath, { recursive: true })
    try {
      await initRepository(projectPath)
    } catch (err) {
      // A retry must not find its own half-made folder "already exists".
      await rm(projectPath, { recursive: true, force: true })
      throw err
    }
    return { path: projectPath, projectKey: await registerProject(projectPath) }
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

  return { prepareDispatchCheckout, dispatchCheckoutPathOf }
}

function installStepForAgent(agent: SetupAgent): SetupStreamStep {
  return agent === 'claude' ? 'install-claude' : 'install-codex'
}

/** Readiness cares only about "can this host run the agent", so an unknown auth probe reads as not signed in. */
async function agentReadiness(agent: SetupAgent, deps: AgentAuthProbeDeps = {}): Promise<HostReadiness['agents'][SetupAgent]> {
  const check = await checkAgentAuth(agent, deps)
  return { installed: check.installed, signedIn: check.installed && check.authenticated === true }
}

async function checkAgentAuth(agent: SetupAgent, deps: AgentAuthProbeDeps = {}): Promise<SetupAgentAuthCheckResult> {
  const resolveBinary = deps.resolveAgentBinary ?? whichAgentBinary
  const checkClaudeAuth = deps.hasClaudeAuth ?? hasClaudeAuth
  const checkCodexAuth = deps.hasCodexAuth ?? hasCodexAuth
  const installed = !!await resolveBinary(agent === 'claude' ? 'claude-code' : 'codex')
  return {
    agent,
    installed,
    authenticated: installed
      ? await (agent === 'claude' ? checkClaudeAuth() : checkCodexAuth())
      : false,
  }
}

/**
 * Only dispatch checkouts need a device: a checkout belongs to the paired
 * device that asked for it (ADR-0011), so without one there is no path to write
 * to. The rest of setup does not — reaching a handler at all already means the
 * socket was admitted, and the handshake admits nobody the bind policy has not
 * already trusted. A loopback or trusted-network client connects tokenless by
 * design, so a blanket device check here rejects exactly the clients the policy
 * meant to let in.
 */
function requireDispatchDevice(deviceId: string | undefined): string {
  if (!deviceId) throw new Error('Dispatch checkouts require a paired device. Pair this client with the host, then try again.')
  return deviceId
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

/** Runs a short read-only command and returns its trimmed output, or null if it can't. */
function runProbe(command: string, args: string[]): string | null {
  try {
    const run = launchProcess(command, withBareRepositoryGuard(command, args))
    const out = execFileSync(run.file, run.args, {
      encoding: 'utf8',
      env: run.env,
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
    const run = launchProcess(command, withBareRepositoryGuard(command, args))
    execFileSync(run.file, run.args, {
      env: run.env,
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

async function safeLoadGithubToken(
  loader: () => Promise<GithubStoredToken | null> = () => githubCredentials().accountToken(),
): Promise<GithubStoredToken | null> {
  try {
    return await loader()
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
  partialClone: boolean
  spawnProcess: SpawnProcess
  emitStatus(event: SetupStatusEvent): void
  emitLog(event: SetupLogEvent): void
  emitFailureStatus: boolean
  progress?: RepositoryProgress
}): Promise<CloneAuth> {
  const {
    step, attemptUrl, parent, targetPath, isHttps, token, partialClone,
    spawnProcess, emitStatus, emitLog, emitFailureStatus, progress,
  } = opts
  const cloneArgs = partialClone ? PARTIAL_CLONE_ARGS : []
  const auth = gitCommandAuth({ isHttps, token: token?.accessToken ?? null })
  // Cloning into a basename from the parent keeps git's counting/receiving
  // lines on the stream; a full destination path suppresses them.
  const spec: ProcessCommandSpec = {
    command: 'git',
    // `--` keeps a destination folder named like `-x` from being read as an option.
    args: withBareRepositoryGuard('git', [...auth.args, 'clone', '--progress', ...cloneArgs, '--', attemptUrl, basename(targetPath)]),
    display: ['git clone --progress', ...cloneArgs, '--', attemptUrl, basename(targetPath)].join(' '),
  }
  emitLog({ step, line: `Cloning ${attemptUrl} into ${targetPath}` })
  await runSetupProcess({
    step,
    spec,
    spawnProcess,
    emitStatus,
    emitLog,
    cwd: parent,
    emitFailureStatus,
    env: auth.env,
    progress,
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
  env?: NodeJS.ProcessEnv
  /** A fallback attempt is not a failed setup step until its final attempt fails. */
  emitFailureStatus?: boolean
  /** Returns a user-facing error when a zero exit did not achieve the intended state. */
  verifySuccess?(): string | null
  /** Takes the lines a process writes again in place, and stops the process. */
  progress?: RepositoryProgress
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
    progress,
  } = opts
  emitStatus({ step, status: 'running' })

  // Waits for a member's GitHub connection, so their home's helper can answer a clone.
  const run = launchedProcess(await currentIdentity('a setup step').launchOptions({ FORCE_COLOR: '0', ...env }), spec.command, spec.args)
  const child = spawnProcess(run.file, run.args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: run.env,
    signal: progress?.signal,
  })

  let settled = false
  const outputTail: string[] = []
  const emitOutputLine = (line: string) => {
    emitLog({ step, line })
    if (!line.trim()) return
    outputTail.push(line)
    if (outputTail.length > 3) outputTail.shift()
  }
  const onProgress = progress && ((line: string) => progress.onOutput(line, true))
  const stdout = createLineBuffer(emitOutputLine, onProgress)
  const stderr = createLineBuffer(emitOutputLine, onProgress)
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

/**
 * Splits a process's output into lines. With `onProgress`, a line that ends in
 * a carriage return goes there instead: git writes its transfer counts again in
 * place that way, so each one is an update and not a new line.
 */
function createLineBuffer(onLine: (line: string) => void, onProgress?: (line: string) => void): LineBuffer {
  let buffered = ''
  let emitted = 0
  const clean = (value: string) => value.replace(ANSI_RE, '').trimEnd()
  const emit = (value: string) => {
    const line = clean(value)
    if (!line.trim()) return
    emitted++
    if (emitted > MAX_SETUP_LOG_LINES) return
    onLine(line)
  }
  const ending = onProgress ? /\r\n|\n|\r/g : /\r?\n/g
  return {
    write(chunk) {
      buffered += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk)
      let start = 0
      for (const match of buffered.matchAll(ending)) {
        const part = buffered.slice(start, match.index)
        start = match.index + match[0].length
        if (match[0] === '\r' && onProgress) {
          const line = clean(part)
          if (line.trim()) onProgress(line)
        } else {
          emit(part)
        }
      }
      buffered = buffered.slice(start)
    },
    flush() {
      if (!buffered) return
      emit(buffered)
      buffered = ''
    },
  }
}
