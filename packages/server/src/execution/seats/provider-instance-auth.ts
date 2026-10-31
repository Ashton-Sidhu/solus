import { execFile } from 'node:child_process'
import { z } from 'zod'
import type { ProviderInstanceStatus } from '@solus/contracts/provider-instances'
import type { Seat, SeatConnectStartResult } from '@solus/contracts/seats'
import { launchedProcess } from '../../cli-env'
import { requirePersonKey } from '../../vault/acting-scope'
import { CodexAppServerClient } from '../agents/codex/codex-agent'
import { privateProviderInstances } from './provider-instances'
import { instanceRuntime, prepareProviderHome, type ProviderRuntime } from './provider-runtime'
import { type SeatConnector } from './seat-connect'
import type { SeatStore } from './seat-manager'

const claudeAccountSchema = z.object({ loggedIn: z.boolean(), email: z.string().nullish(), subscriptionType: z.string().nullish() })
interface AuthState { phase: ProviderInstanceStatus['phase']; error: string | null }

/** Instance sign-ins use the existing relayed CLI flow, scoped to the caller and instance. */
export class ProviderInstanceAuth {
  private readonly pending = new Map<string, Promise<ProviderInstanceStatus>>()
  private readonly states = new Map<string, AuthState>()
  constructor(private readonly deps: { seats: SeatStore; connector: SeatConnector; changed: () => void }) {}

  private target(seat: Seat, instanceId: string) {
    const personKey = requirePersonKey()
    const instance = privateProviderInstances().lookup(personKey, instanceId)
    const home = this.deps.seats.homeFor(seat, instance.provider)
    // The host login lives where the CLI looks by default, as its runs do. Naming
    // that directory changes where the CLI reads its login: on macOS, Claude Code
    // keys its keychain entry by CLAUDE_CONFIG_DIR, so the login looks absent.
    const configured = instance.homePath || seat.kind === 'host-login' ? instance : { ...instance, homePath: home }
    return { personKey, instance, home, runtime: instanceRuntime(configured, undefined, 0, home), key: `${personKey}\n${instanceId}` }
  }

  async status(seat: Seat, instanceId: string): Promise<ProviderInstanceStatus> {
    const { instance, runtime, key } = this.target(seat, instanceId)
    const pendingKey = `${key}\n${runtime.key}`
    const pending = this.pending.get(pendingKey)
    if (pending) return pending
    const result = this.readStatus(instanceId, instance.provider, runtime, key)
    this.pending.set(pendingKey, result)
    try { return await result } finally { if (this.pending.get(pendingKey) === result) this.pending.delete(pendingKey) }
  }

  private async readStatus(instanceId: string, provider: 'codex' | 'claude-code', runtime: ProviderRuntime, key: string): Promise<ProviderInstanceStatus> {
    let version: string | null = null
    let account: string | null = null
    let authenticated = false
    let error: string | null = null
    try {
      version = (await cliOutput(runtime, ['--version'])).trim().slice(0, 120)
      const auth = await this.account(provider, runtime)
      authenticated = auth.authenticated
      account = auth.account
    } catch {
      error = version ? 'Could not read this instance’s authentication status.' : 'This instance’s executable could not be started. Check its binary path.'
    }
    const state = this.states.get(key)
    return { instanceId, checkedAt: Date.now(), version, authenticated, account, phase: state?.phase ?? (authenticated ? 'connected' : 'idle'), error: state?.error ?? error }
  }

  async start(seat: Seat, instanceId: string): Promise<SeatConnectStartResult> {
    const { instance, runtime, personKey, key, home: seatHome } = this.target(seat, instanceId)
    if (!instance.enabled) throw new Error('Enable this provider instance before signing in.')
    const home = runtime.homePath ?? seatHome
    prepareProviderHome(runtime)
    return this.deps.connector.start(seat, instance.provider, {
      id: instanceId, home, binaryPath: runtime.binaryPath, launch: runtime.launch,
      changed: async (phase, error) => {
        this.states.set(key, { phase, error: error ?? null })
        if (phase === 'connected') {
          privateProviderInstances().authenticationChanged(personKey, instanceId)
          if (!instance.homePath && !instance.shadowHomePath) await this.deps.seats.markConnected(seat, instance.provider, 'login')
        }
        this.deps.changed()
      },
      verify: async () => (await this.account(instance.provider, runtime)).authenticated,
    })
  }

  submit(seat: Seat, instanceId: string, code: string): void {
    const { instance } = this.target(seat, instanceId)
    this.deps.connector.submitCode(seat, instance.provider, code, instanceId)
  }

  async cancel(seat: Seat, instanceId: string): Promise<boolean> {
    const { instance } = this.target(seat, instanceId)
    return this.deps.connector.cancel(seat, instance.provider, instanceId)
  }

  async disconnect(seat: Seat, instanceId: string): Promise<ProviderInstanceStatus> {
    const { instance, runtime, personKey, key } = this.target(seat, instanceId)
    await this.deps.connector.cancel(seat, instance.provider, instanceId)
    await cliOutput(runtime, instance.provider === 'codex' ? ['logout'] : ['auth', 'logout'])
    privateProviderInstances().authenticationChanged(personKey, instanceId)
    this.states.set(key, { phase: 'idle', error: null })
    this.deps.changed()
    return this.status(seat, instanceId)
  }

  private async account(provider: 'codex' | 'claude-code', runtime: ProviderRuntime): Promise<{ authenticated: boolean; account: string | null }> {
    if (provider === 'claude-code') {
      const parsed = claudeAccountSchema.parse(JSON.parse(await cliOutput(runtime, ['auth', 'status'], true)))
      return { authenticated: parsed.loggedIn, account: [parsed.email, parsed.subscriptionType].filter(Boolean).join(' · ') || null }
    }
    const client = new CodexAppServerClient({ binaryPath: runtime.binaryPath, codexHome: runtime.homePath, launch: runtime.launch })
    try {
      const { account } = await client.request('account/read', { refreshToken: false })
      return { authenticated: account !== null, account: account?.type === 'chatgpt' ? [account.email, account.planType].filter(Boolean).join(' · ') : account?.type ?? null }
    } finally { client.shutdown() }
  }
}

function cliOutput(runtime: ProviderRuntime, args: string[], acceptStatusOutput = false): Promise<string> {
  const command = launchedProcess(runtime.launch, runtime.binaryPath, args)
  return new Promise((resolve, reject) => {
    execFile(command.file, command.args, { env: command.env, timeout: 10000, maxBuffer: 65536 }, (error, stdout) => {
      if (error && !(acceptStatusOutput && stdout.trim())) reject(new Error('Provider command failed.'))
      else resolve(stdout)
    })
  })
}
