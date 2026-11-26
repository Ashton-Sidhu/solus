import { execFile, spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Seat, SeatConnectStartResult, SeatProvider } from '@solus/contracts/seats'
import { launchOptions, launchProcess, launchedProcess, type LaunchedProcess, type LaunchOptions } from '../../cli-env'
import { ANTIGRAVITY_COMMAND, antigravityArgs, antigravitySignInUrl } from '../agents/acp/antigravity'
import { antigravityAuthOf, antigravityEnvironment, antigravitySignedIn, prepareAntigravityProfile } from '../agents/acp/antigravity-auth'
import { EnterpriseAlreadySignedIn, startEnterpriseSignIn, type EnterpriseSignIn, type EnterpriseSignInOptions } from './antigravity-enterprise-sign-in'
import { ANTIGRAVITY_BROWSER_HELPER } from './seat-manager'
import type { AntigravityBrowserSignIn } from '@solus/contracts/seats'
import { resolveHomePath } from '../../platform/paths'
import { createLogger } from '../../logger'
import { providerLoginConnected, seatEnv } from './seat-login'
import { seatKey, seatProviderLabel, type SeatStore } from './seat-manager'

const log = createLogger('main', 'seat-connect')

/** A browser login can wait this long for the member; then the process is ended and the seat stays `none`. */
const CONNECT_TIMEOUT_MS = 15 * 60_000
/** How long the CLI gets to print where to sign in before the start call gives up. */
const VERIFICATION_TIMEOUT_MS = 60_000
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
/**
 * Colors, and OSC sequences: Claude wraps its sign-in link in an OSC 8 hyperlink
 * (`ESC]8;;<url>BEL<url>ESC]8;;BEL`), which left the URL glued to its own copy.
 * An OSC still arriving at the end of the output is dropped, so a half-printed link is never taken.
 */
const TERMINAL_CODES_RE = new RegExp(`${ESC}\\[[0-9;]*m|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\|$)`, 'g')

export type SpawnProcess = (command: string, args: string[], options: Parameters<typeof nodeSpawn>[2]) => ChildProcess

/**
 * The relayed connect (docs/plans/provider-seats.md §3.6, proofs of 2026-09-04):
 * the provider CLI's own login runs on the host inside the seat directory, with
 * `open` shimmed so no browser opens here. The URL it prints goes out to the
 * client; the code the person brings back goes in on stdin. The CLI writes the
 * credential itself, so no token passes through Solus. The host owner's seat is
 * the host's own provider home, so the setup wizard's sign-in is this same relay.
 *
 * One login per (seat, provider) at a time; a fresh start supersedes an
 * abandoned one, which also recovers a client that left before it could cancel.
 */
export interface InstanceConnectTarget {
  id: string
  home: string
  binaryPath: string
  launch: LaunchOptions
  changed: (state: 'connecting' | 'connected' | 'failed', error?: string) => Promise<void>
  verify: () => Promise<boolean>
}

export class SeatConnector {
  private readonly active = new Map<string, ActiveConnect>()
  /** Gemini Enterprise sign-ins, which agy runs over ACP rather than as a CLI login. */
  private readonly enterprise = new Map<string, EnterpriseSignIn>()
  private readonly spawnProcess: SpawnProcess
  private readonly verifyLogin: (provider: SeatProvider, home: string | null) => Promise<boolean>

  constructor(private readonly deps: {
    seats: SeatStore
    spawnProcess?: SpawnProcess
    /** Whether the CLI left a working credential in the seat's directory (`null`: the host's defaults). */
    verifyLogin?: (provider: SeatProvider, home: string | null) => Promise<boolean>
    connectTimeoutMs?: number
    /** Starts a Gemini Enterprise sign-in; tests give one that runs no agy. */
    startEnterprise?: (options: EnterpriseSignInOptions) => Promise<EnterpriseSignIn>
  }) {
    this.spawnProcess = deps.spawnProcess ?? nodeSpawn
    this.verifyLogin = deps.verifyLogin ?? providerLoginConnected
  }

  /**
   * Starts the login and answers once the CLI has printed where to sign in.
   * `antigravity`: how an Antigravity seat signs in; absent, the way it last
   * signed in in the browser, else a Google account.
   */
  async start(seat: Seat, provider: SeatProvider, target?: InstanceConnectTarget, antigravity?: AntigravityBrowserSignIn): Promise<SeatConnectStartResult> {
    const key = connectKey(seat, provider, target?.id)
    await this.cancel(seat, provider, target?.id)
    const home = target?.home ?? this.deps.seats.homeFor(seat, provider)
    const signIn = provider === 'antigravity' && !target ? antigravity ?? savedBrowserSignIn(home) : null
    if (signIn?.method === 'oauth-business') return this.startEnterprise(seat, key, home, signIn)
    // The host login signs in where the CLI looks by default; a user's seat is named explicitly.
    const seatHome = target ? home : seat.kind === 'host-login' ? null : home
    const spec = loginCommand(provider, home)
    const run = target ? launchedProcess(target.launch, target.binaryPath, spec.args)
      : provider === 'antigravity' ? antigravityLoginProcess(home, spec.args)
      : launchProcess(spec.command, spec.args, { FORCE_COLOR: '0', ...seatEnv(provider, seatHome) })
    const { env } = run
    env.PATH = `${this.deps.seats.shimBinDir()}:${env.PATH ?? ''}`
    // A login must be the person's own: nothing the host process carries may answer for it.
    delete env.CLAUDE_CODE_OAUTH_TOKEN
    delete env.ANTHROPIC_API_KEY
    delete env.OPENAI_API_KEY

    const child = this.spawnProcess(run.file, run.args, {
      cwd: resolveHomePath(home),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env,
    })
    const entry: ActiveConnect = { child, output: '', verification: null, settle: () => {}, done: Promise.resolve() }
    entry.done = new Promise<void>((resolve) => { entry.settle = resolve })
    this.active.set(key, entry)
    void (target ? target.changed('connecting') : this.deps.seats.markConnecting(seat, provider))
    log.info('seat_connect_started', { seat: seatKey(seat), provider, command: spec.display })

    let resolveVerification: (result: SeatConnectStartResult) => void = () => {}
    let rejectVerification: (error: Error) => void = () => {}
    const verification = new Promise<SeatConnectStartResult>((resolve, reject) => {
      resolveVerification = resolve
      rejectVerification = reject
    })
    const onOutput = (chunk: Buffer | string) => {
      entry.output = `${entry.output}${chunk.toString()}`.slice(-8_192)
      if (entry.verification) return
      const text = entry.output.replace(TERMINAL_CODES_RE, '')
      const googleUrl = provider === 'antigravity' ? antigravitySignInUrl(text) : null
      const parsed = googleUrl ? { url: googleUrl, requiresCodeInput: true } : provider === 'antigravity' ? null : parseAgentSignInVerification(text)
      if (!parsed) return
      const result: SeatConnectStartResult = {
        verificationUrl: parsed.url,
        // Claude's and Antigravity's pages show a code that comes back here; Codex shows its code here.
        requiresCodeInput: parsed.requiresCodeInput === true || provider !== 'codex',
      }
      if (parsed.code) result.userCode = parsed.code
      entry.verification = result
      resolveVerification(result)
    }
    child.stdout?.on('data', onOutput)
    child.stderr?.on('data', onOutput)

    const timeout = setTimeout(() => {
      log.warn('seat_connect_timed_out', { seat: seatKey(seat), provider })
      terminateProcessTree(child, 'SIGTERM')
    }, this.deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS)
    timeout.unref()

    // agy 1.5 keeps a Google sign-in in the OS keychain on macOS, where Solus cannot
    // read it: its clean exit is the proof that it accepted the sign-in, as for Gemini Enterprise.
    const acceptedOnExit = signIn?.method === 'oauth-personal'
    const finish = async (outcome: { code: number | null; signal: NodeJS.Signals | null } | { error: Error }): Promise<void> => {
      clearTimeout(timeout)
      if (this.active.get(key) === entry) this.active.delete(key)
      const tail = entry.output.replace(TERMINAL_CODES_RE, '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join('\n')
      try {
        if ('error' in outcome) {
          await (target ? target.changed('failed', outcome.error.message) : this.deps.seats.markFailed(seat, provider, outcome.error.message))
          rejectVerification(outcome.error)
        } else if (outcome.signal) {
          await (target ? target.changed('failed', 'Sign-in was cancelled.') : this.deps.seats.markFailed(seat, provider, 'Sign-in was cancelled.'))
          rejectVerification(new Error('Sign-in was cancelled.'))
        } else if (outcome.code !== 0) {
          const message = `${seatProviderLabel(provider)} sign-in exited with code ${outcome.code ?? 'unknown'}${tail ? `:\n${tail}` : ''}`
          await (target ? target.changed('failed', message) : this.deps.seats.markFailed(seat, provider, message))
          rejectVerification(new Error(message))
        } else if (!acceptedOnExit && !(target ? await target.verify() : signIn ? antigravitySignedIn(home, signIn) : await this.verifyLogin(provider, seatHome))) {
          const message = `${seatProviderLabel(provider)} sign-in finished, but no credential was saved for your seat.`
          await (target ? target.changed('failed', message) : this.deps.seats.markFailed(seat, provider, message))
          rejectVerification(new Error(message))
        } else {
          const record = acceptedOnExit ? { ...signIn, verifiedAt: Date.now() } : signIn ?? undefined
          await (target ? target.changed('connected') : this.deps.seats.markConnected(seat, provider, 'login', record))
        }
      } finally {
        entry.settle()
      }
    }
    child.once('error', (error) => void finish({ error }))
    child.once('close', (code, signal) => void finish({ code, signal }))

    const startTimeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${seatProviderLabel(provider)} did not print a sign-in link.`)), VERIFICATION_TIMEOUT_MS)
      timer.unref()
      void entry.done.then(() => clearTimeout(timer))
    })
    try {
      return await Promise.race([verification, startTimeout])
    } catch (error) {
      terminateProcessTree(child, 'SIGTERM')
      throw error
    }
  }

  /**
   * A Gemini Enterprise sign-in in the browser, relayed to agy on the host. The
   * seat records the sign-in once agy accepts it, so a reconnect from any
   * surface signs in to the same project.
   */
  private async startEnterprise(seat: Seat, key: string, profile: string, signIn: Extract<AntigravityBrowserSignIn, { method: 'oauth-business' }>): Promise<SeatConnectStartResult> {
    void this.deps.seats.markConnecting(seat, 'antigravity')
    const record = { method: 'oauth-business' as const, gcpProject: signIn.gcpProject, gcpLocation: signIn.gcpLocation }
    let flow: EnterpriseSignIn
    try {
      flow = await (this.deps.startEnterprise ?? startEnterpriseSignIn)({
        profile,
        gcpProject: signIn.gcpProject,
        gcpLocation: signIn.gcpLocation,
        launch: launchOptions(),
        browserHelper: join(this.deps.seats.shimBinDir(), ANTIGRAVITY_BROWSER_HELPER),
        shimBin: this.deps.seats.shimBinDir(),
      })
    } catch (error) {
      if (error instanceof EnterpriseAlreadySignedIn) await this.deps.seats.markConnected(seat, 'antigravity', 'login', { ...record, verifiedAt: Date.now() })
      else await this.deps.seats.markFailed(seat, 'antigravity', error instanceof Error ? error.message : String(error))
      throw error
    }
    this.enterprise.set(key, flow)
    log.info('seat_connect_started', { seat: seatKey(seat), provider: 'antigravity', command: 'agy acp authenticate oauth-business' })
    flow.done.then(
      () => this.deps.seats.markConnected(seat, 'antigravity', 'login', { ...record, verifiedAt: Date.now() }),
      (error: Error) => this.deps.seats.markFailed(seat, 'antigravity', error.message),
    ).catch(() => {}).finally(() => {
      if (this.enterprise.get(key) === flow) this.enterprise.delete(key)
    })
    return { verificationUrl: flow.verificationUrl, requiresCodeInput: true, input: 'redirect-url' }
  }

  /** The code the member's browser handed back, for the login waiting on stdin, or a Gemini Enterprise redirect for agy's listener. */
  async submitCode(seat: Seat, provider: SeatProvider, code: string, instanceId?: string): Promise<void> {
    const flow = this.enterprise.get(connectKey(seat, provider, instanceId))
    if (flow) return flow.submit(code)
    const entry = this.active.get(connectKey(seat, provider, instanceId))
    const stdin = entry?.child.stdin
    if (!stdin?.writable) throw new Error(`${seatProviderLabel(provider)} sign-in is not waiting for a code.`)
    stdin.write(`${coerceAgentSignInCode(code)}\n`)
  }

  async cancel(seat: Seat, provider: SeatProvider, instanceId?: string): Promise<boolean> {
    const flow = this.enterprise.get(connectKey(seat, provider, instanceId))
    if (flow) {
      flow.cancel()
      await flow.done.catch(() => {})
      return true
    }
    const entry = this.active.get(connectKey(seat, provider, instanceId))
    if (!entry) return false
    terminateProcessTree(entry.child, 'SIGTERM')
    await entry.done
    return true
  }

  /** Ends every login still waiting: the host is shutting down. */
  async stopAll(): Promise<void> {
    for (const flow of this.enterprise.values()) flow.cancel()
    const entries = [...this.active.values()]
    for (const entry of entries) terminateProcessTree(entry.child, 'SIGTERM')
    await Promise.all(entries.map((entry) => entry.done))
  }
}

interface ActiveConnect {
  child: ChildProcess
  output: string
  verification: SeatConnectStartResult | null
  settle: () => void
  done: Promise<void>
}

/** The browser sign-in an Antigravity seat used last: a Gemini Enterprise one keeps its project. */
function savedBrowserSignIn(profile: string): AntigravityBrowserSignIn {
  const auth = antigravityAuthOf(profile)
  return auth.method === 'oauth-business' && auth.gcpProject && auth.gcpLocation
    ? { method: 'oauth-business', gcpProject: auth.gcpProject, gcpLocation: auth.gcpLocation }
    : { method: 'oauth-personal' }
}

function connectKey(seat: Seat, provider: SeatProvider, instanceId?: string): string {
  return `${seatKey(seat)}\n${provider}${instanceId ? `\n${instanceId}` : ''}`
}

function loginCommand(provider: SeatProvider, home: string) {
  switch (provider) {
    case 'claude-code': return { command: 'claude', args: ['auth', 'login'], display: 'claude auth login' }
    case 'codex': return { command: 'codex', args: ['login', '--device-auth'], display: 'codex login --device-auth' }
    case 'antigravity': return { command: ANTIGRAVITY_COMMAND, args: antigravityArgs(home, { login: true }), display: 'agy acp --login' }
  }
}

/**
 * agy signs in to the seat's own profile, with its file storage, and without
 * the host's Google credentials (docs/plans/antigravity-provider.md §7).
 */
function antigravityLoginProcess(profile: string, args: string[]): LaunchedProcess {
  const base = launchOptions()
  prepareAntigravityProfile(profile, { method: 'oauth-personal' }, base.user ?? null)
  return launchedProcess({ ...base, env: antigravityEnvironment(base.env, profile, { method: 'oauth-personal' }) }, ANTIGRAVITY_COMMAND, args)
}

/**
 * Agent CLIs vary their surrounding prose, so only browser URLs, device codes
 * and Claude's explicit browser fallback are scraped. Missing or unfamiliar
 * output simply returns null while the unmodified lines keep streaming.
 */
export function parseAgentSignInVerification(output: string): { url: string; code?: string; requiresCodeInput?: boolean } | null {
  const text = output.replace(TERMINAL_CODES_RE, '')
  const urls = [...text.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)]
  const lastUrl = urls.at(-1)
  const url = lastUrl?.[0]?.replace(/[.,;:]+$/, '')
  const codePatterns = [
    /enter\s+(?:this\s+)?(?:one[- ]time\s+)?code(?:[ \t]*\([^)\r\n]*\))?[ \t]*(?:is|:)?[ \t]*\r?\n[ \t]*([A-Z0-9][A-Z0-9-]{3,31})/i,
    /(?:verification|device)\s+code\s*(?:is|:)\s*([A-Z0-9][A-Z0-9-]{3,31})/i,
    /\bcode\s*(?:is|:)\s*([A-Z0-9][A-Z0-9-]{3,31})/i,
  ]
  const code = codePatterns
    .map((pattern) => pattern.exec(text)?.[1])
    .find((candidate): candidate is string => !!candidate)
  if (url && code) return { url, code }
  // The link may still be arriving: take it only once something follows it.
  const isUrlComplete = !!lastUrl && lastUrl.index + lastUrl[0].length < text.length
  if (url && isUrlComplete && /browser\s+didn['’]?t\s+open,\s*visit/i.test(text)) {
    return { url, requiresCodeInput: true }
  }
  return null
}

/** The CLI reads one response line; reject extra control characters and oversized input. */
export function coerceAgentSignInCode(value: string): string {
  const code = value.trim()
  if (!code) throw new Error('Sign-in code is required.')
  if (code.length > 4_096 || [...code].some((character) => character === '\r' || character === '\n' || character === '\0')) {
    throw new Error('Sign-in code is invalid.')
  }
  return code
}

/** The login runs in its own process group, so cancelling reaches the CLI's wrappers and children too. */
export function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  // Windows has no process groups and no signals: `taskkill /T` ends the CLI and every process it started.
  if (process.platform === 'win32' && child.pid) {
    execFile('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }, () => {})
    return
  }
  if (child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // The wrapper may have exited between the status check and this signal.
    }
  }
  child.kill(signal)
}
