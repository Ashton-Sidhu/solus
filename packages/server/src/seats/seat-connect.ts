import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import type { SeatConnectStartResult, SeatProvider } from '@solus/contracts/seats'
import { HOST_OWNER_USER_ID } from '@solus/contracts/sharing'
import { getCliEnv } from '../cli-env'
import { createLogger } from '../logger'
import { providerLoginConnected, seatEnv } from './seat-login'
import { seatProviderLabel, type SeatStore } from './seat-manager'

const log = createLogger('main', 'seat-connect')

/** A browser login can wait this long for the member; then the process is ended and the seat stays `none`. */
const CONNECT_TIMEOUT_MS = 15 * 60_000
/** How long the CLI gets to print where to sign in before the start call gives up. */
const VERIFICATION_TIMEOUT_MS = 60_000
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

export type SpawnProcess = (command: string, args: string[], options: Parameters<typeof nodeSpawn>[2]) => ChildProcess

/**
 * The relayed connect (docs/plans/provider-seats.md §3.6, proofs of 2026-09-04):
 * the provider CLI's own login runs on the host inside the seat directory, with
 * `open` shimmed so no browser opens here. The URL it prints goes out to the
 * client; the code the person brings back goes in on stdin. The CLI writes the
 * credential itself, so no token passes through Solus. The host owner's seat is
 * the host's own provider home, so the setup wizard's sign-in is this same relay.
 *
 * One login per (user, provider) at a time; a fresh start supersedes an
 * abandoned one, which also recovers a client that left before it could cancel.
 */
export class SeatConnector {
  private readonly active = new Map<string, ActiveConnect>()
  private readonly spawnProcess: SpawnProcess
  private readonly verifyLogin: (provider: SeatProvider, home: string | null) => Promise<boolean>

  constructor(private readonly deps: {
    seats: SeatStore
    spawnProcess?: SpawnProcess
    /** Whether the CLI left a working credential in the seat's directory (`null`: the host's defaults). */
    verifyLogin?: (provider: SeatProvider, home: string | null) => Promise<boolean>
    connectTimeoutMs?: number
  }) {
    this.spawnProcess = deps.spawnProcess ?? nodeSpawn
    this.verifyLogin = deps.verifyLogin ?? providerLoginConnected
  }

  /** Starts the login and answers once the CLI has printed where to sign in. */
  async start(userId: string, provider: SeatProvider): Promise<SeatConnectStartResult> {
    const key = connectKey(userId, provider)
    await this.cancel(userId, provider)
    const home = this.deps.seats.homeFor(userId, provider)
    // The host login signs in where the CLI looks by default; a member's seat is named explicitly.
    const seatHome = userId === HOST_OWNER_USER_ID ? null : home
    const spec = loginCommand(provider)
    const env = getCliEnv({ FORCE_COLOR: '0', ...seatEnv(provider, seatHome) })
    env.PATH = `${this.deps.seats.shimBinDir()}:${env.PATH ?? ''}`
    // A login must be the person's own: nothing the host process carries may answer for it.
    delete env.CLAUDE_CODE_OAUTH_TOKEN
    delete env.ANTHROPIC_API_KEY
    delete env.OPENAI_API_KEY

    const child = this.spawnProcess(spec.command, spec.args, {
      cwd: home,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env,
    })
    const entry: ActiveConnect = { child, output: '', verification: null, settle: () => {}, done: Promise.resolve() }
    entry.done = new Promise<void>((resolve) => { entry.settle = resolve })
    this.active.set(key, entry)
    void this.deps.seats.markConnecting(userId, provider)
    log.info('seat_connect_started', { userId, provider, command: spec.display })

    let resolveVerification: (result: SeatConnectStartResult) => void = () => {}
    let rejectVerification: (error: Error) => void = () => {}
    const verification = new Promise<SeatConnectStartResult>((resolve, reject) => {
      resolveVerification = resolve
      rejectVerification = reject
    })
    const onOutput = (chunk: Buffer | string) => {
      entry.output = `${entry.output}${chunk.toString()}`.slice(-8_192)
      if (entry.verification) return
      const parsed = parseAgentSignInVerification(entry.output.replace(ANSI_RE, ''))
      if (!parsed) return
      const result: SeatConnectStartResult = {
        verificationUrl: parsed.url,
        requiresCodeInput: parsed.requiresCodeInput === true || provider === 'claude-code',
      }
      if (parsed.code) result.userCode = parsed.code
      entry.verification = result
      resolveVerification(result)
    }
    child.stdout?.on('data', onOutput)
    child.stderr?.on('data', onOutput)

    const timeout = setTimeout(() => {
      log.warn('seat_connect_timed_out', { userId, provider })
      terminateProcessTree(child, 'SIGTERM')
    }, this.deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS)
    timeout.unref()

    const finish = async (outcome: { code: number | null; signal: NodeJS.Signals | null } | { error: Error }): Promise<void> => {
      clearTimeout(timeout)
      if (this.active.get(key) === entry) this.active.delete(key)
      const tail = entry.output.replace(ANSI_RE, '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join('\n')
      try {
        if ('error' in outcome) {
          await this.deps.seats.markFailed(userId, provider, outcome.error.message)
          rejectVerification(outcome.error)
        } else if (outcome.signal) {
          await this.deps.seats.markFailed(userId, provider, 'Sign-in was cancelled.')
          rejectVerification(new Error('Sign-in was cancelled.'))
        } else if (outcome.code !== 0) {
          const message = `${seatProviderLabel(provider)} sign-in exited with code ${outcome.code ?? 'unknown'}${tail ? `:\n${tail}` : ''}`
          await this.deps.seats.markFailed(userId, provider, message)
          rejectVerification(new Error(message))
        } else if (!await this.verifyLogin(provider, seatHome)) {
          const message = `${seatProviderLabel(provider)} sign-in finished, but no credential was saved for your seat.`
          await this.deps.seats.markFailed(userId, provider, message)
          rejectVerification(new Error(message))
        } else {
          await this.deps.seats.markConnected(userId, provider, 'login')
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

  /** The code the member's browser handed back, for the login waiting on stdin. */
  submitCode(userId: string, provider: SeatProvider, code: string): void {
    const entry = this.active.get(connectKey(userId, provider))
    const stdin = entry?.child.stdin
    if (!stdin?.writable) throw new Error(`${seatProviderLabel(provider)} sign-in is not waiting for a code.`)
    stdin.write(`${coerceAgentSignInCode(code)}\n`)
  }

  async cancel(userId: string, provider: SeatProvider): Promise<boolean> {
    const entry = this.active.get(connectKey(userId, provider))
    if (!entry) return false
    terminateProcessTree(entry.child, 'SIGTERM')
    await entry.done
    return true
  }

  /** Ends every login still waiting: the host is shutting down. */
  async stopAll(): Promise<void> {
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

function connectKey(userId: string, provider: SeatProvider): string {
  return `${userId}\n${provider}`
}

function loginCommand(provider: SeatProvider): { command: string; args: string[]; display: string } {
  return provider === 'claude-code'
    ? { command: 'claude', args: ['auth', 'login'], display: 'claude auth login' }
    : { command: 'codex', args: ['login', '--device-auth'], display: 'codex login --device-auth' }
}

/**
 * Agent CLIs vary their surrounding prose, so only browser URLs, device codes
 * and Claude's explicit browser fallback are scraped. Missing or unfamiliar
 * output simply returns null while the unmodified lines keep streaming.
 */
export function parseAgentSignInVerification(output: string): { url: string; code?: string; requiresCodeInput?: boolean } | null {
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
  if (url && code) return { url, code }
  if (url && /browser\s+didn['’]?t\s+open,\s*visit/i.test(text)) {
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
