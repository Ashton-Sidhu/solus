import { policyGate, type LaunchPolicy } from '../../host/policy/policy-gate'
import { resolveProjectRoot } from '../../project-config/project-config'
import { instanceModelCatalog } from '@solus/contracts/provider-instance-models'
import type { ModelProfile } from '@solus/contracts/types'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, symlinkSync, lstatSync, readlinkSync, chownSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import type { ProviderInstance } from '@solus/contracts/provider-instances'
import type { AgentRunRequest, AgentRunSessionState } from '../agents/agent-runner'
import type { LaunchOptions } from '../../cli-env'
import { captureActingScope } from '../../vault/acting-scope'
import { resolveHomePath } from '../../platform/paths'
import { privateProviderInstances } from './provider-instances'

export interface ProviderRuntime {
  /** Opaque, private process-pool identity. Never contains credentials or a person key. */
  key: string
  historyReference: string
  binaryPath: string
  launchArgs: string[]
  homePath?: string
  sharedHomePath?: string
  idleCompaction?: 'onReturn' | 'off'
  autoCompactWindow?: number
  modelProfiles?: Record<string, ModelProfile>
  launch: LaunchOptions
}

function privatePath(value: string, home: string, owner: boolean, seatHome?: string): string {
  const expanded = value === '~' ? home : value.startsWith('~/') ? join(home, value.slice(2)) : resolveHomePath(value)
  if (!isAbsolute(expanded)) throw new Error('Provider home paths must be absolute or start with ~/.')
  if (!owner) {
    const pathFromHome = relative(home, expanded)
    const pathFromSeat = seatHome ? relative(seatHome, expanded) : '..'
    const insideSeat = pathFromSeat !== '..' && !pathFromSeat.startsWith('../') && !isAbsolute(pathFromSeat)
    if (!insideSeat && (pathFromHome === '..' || pathFromHome.startsWith('../') || isAbsolute(pathFromHome))) throw new Error('A provider home must be inside your own home on this host.')
  }
  return expanded
}

/** Resolve only the caller's launch settings. Running processes keep their captured configuration. */
export function prepareProviderRun(request: AgentRunRequest, sessionState?: AgentRunSessionState): AgentRunRequest {
  if (request.provider !== 'codex' && request.provider !== 'claude-code') return request
  const scope = captureActingScope()
  if (!scope?.personKey) return request
  const projectPath = request.projectRoot ?? request.cwd
  const chosen = privateProviderInstances().forRun(scope.personKey, request.provider, sessionState?.sessionId, request.conversation?.kind === 'resume', projectPath ? resolveProjectRoot(resolveHomePath(projectPath)) : undefined)
  const { authEpoch, idleCompaction } = chosen
  const instance = governedInstance(chosen.instance, policyGate().launchPolicy(request.organizationId, request.provider))
  const configured = request.provider === 'claude-code' || idleCompaction === 'off' || authEpoch > 0 || instance.id !== request.provider || hasRuntimeOverrides(instance)
  if (!configured) return request
  const launch = request.seat?.launch
  const token = request.seat?.envToken
  const scopedLaunch = launch && token && !instance.homePath ? { ...launch, env: { ...launch.env, CLAUDE_CODE_OAUTH_TOKEN: token } } : launch
  const runtime = instanceRuntime(instance, scopedLaunch, authEpoch, request.seat?.home)
  runtime.idleCompaction = idleCompaction
  prepareProviderHome(runtime)
  return { ...request, ...instanceModelOptions(request, runtime), providerRuntime: runtime }
}

export function instanceRuntime(instance: ProviderInstance, seatLaunch?: LaunchOptions, authEpoch = 0, seatHome?: string): ProviderRuntime {
  const scope = captureActingScope()
  if (!scope?.personKey) throw new Error('A provider instance needs an acting Solus user.')
  const launch = seatLaunch ?? scope.identity.launchOptionsSync()
  const env = instanceEnvironment(instance, launch.env)
  const paths = instancePaths(instance, launch, scope.identity.isHost, seatHome)
  if (paths.homePath) env[instance.provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] = paths.homePath
  const { binaryPath, homePath } = paths
  const authStamp = authenticationStamp(instance.provider, homePath ?? seatHome, launch.env)
  const key = createHash('sha256').update(JSON.stringify({ person: scope.personKey, instance: instance.id, authEpoch, authStamp, binaryPath, home: homePath, args: instance.launchArgs, env })).digest('hex')
  const historyReference = providerHistoryReference(scope.personKey, instance.id)
  const runtime: ProviderRuntime = { key, historyReference, binaryPath, launchArgs: instance.launchArgs, launch: { ...launch, env } }
  if (instance.customModels.length) runtime.modelProfiles = instanceModelCatalog(instance).modelProfiles
  if (instance.autoCompactWindow !== null) runtime.autoCompactWindow = instance.autoCompactWindow
  if (paths.sharedHomePath) runtime.sharedHomePath = paths.sharedHomePath
  if (homePath) runtime.homePath = homePath
  return runtime
}

/**
 * The instance as the policies allow it to launch (plans/030 §6.4). Under a
 * ceiling the policy owns the launch: the person's binary, arguments, environment,
 * and homes are dropped, because a wrapper, a flag, or a variable could turn the
 * provider's approvals off. A launch pin is laid over what remains. The stored
 * instance is not changed.
 */
export function governedInstance(instance: ProviderInstance, policy: LaunchPolicy): ProviderInstance {
  const { ownsLaunch, pin } = policy
  if (!ownsLaunch && !pin) return instance
  const governed: ProviderInstance = ownsLaunch
    ? { ...instance, binaryPath: '', homePath: '', shadowHomePath: '', launchArgs: [], environment: [] }
    : { ...instance }
  if (pin?.binaryPath) governed.binaryPath = pin.binaryPath
  if (pin?.launchArgs) governed.launchArgs = [...pin.launchArgs]
  if (pin?.environment) {
    const pinned = new Set(pin.environment.map((variable) => variable.name))
    governed.environment = [...governed.environment.filter((variable) => !pinned.has(variable.name)), ...pin.environment.map((variable) => ({ ...variable, sensitive: true }))]
  }
  return governed
}

/** A persisted history locator contains no paths, credentials, or raw person key. */
export function providerHistoryReference(personKey: string, instanceId: string): string {
  return `private-instance:${createHash('sha256').update(personKey).digest('hex')}:${instanceId}`
}

export function providerHistoryInstanceId(reference: string, personKey: string): string {
  const prefix = `private-instance:${createHash('sha256').update(personKey).digest('hex')}:`
  if (!reference.startsWith(prefix)) throw new Error('This provider history belongs to another Solus user’s private instance.')
  const instanceId = reference.slice(prefix.length)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(instanceId)) throw new Error('This provider history has an invalid instance reference.')
  return instanceId
}

function hasRuntimeOverrides(instance: ProviderInstance): boolean {
  return !!instance.binaryPath || !!instance.homePath || !!instance.shadowHomePath || instance.launchArgs.length > 0 || instance.environment.length > 0 || instance.autoCompactWindow !== null || instance.customModels.length > 0
}

function instanceEnvironment(instance: ProviderInstance, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base }
  if (instance.homePath || instance.shadowHomePath) {
    for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY']) delete env[name]
  }
  for (const variable of instance.environment) {
    if (['HOME', 'USERPROFILE', 'USER', 'LOGNAME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'].includes(variable.name)) {
      throw new Error(`Set provider home paths in Runtime instead of overriding ${variable.name}.`)
    }
    env[variable.name] = variable.value
  }
  return env
}

/** Prepare only this instance's home. Authentication files are never shared or copied. */
export function prepareProviderHome(runtime: ProviderRuntime): void {
  if (!runtime.homePath) return
  const firstCreated = mkdirSync(runtime.homePath, { recursive: true, mode: 0o700 })
  if (firstCreated && runtime.launch.user) {
    let folder = runtime.homePath
    while (true) {
      chownSync(folder, runtime.launch.user.uid, -1)
      if (folder === firstCreated) break
      const parent = dirname(folder)
      if (parent === folder) break
      folder = parent
    }
  }
  if (!runtime.sharedHomePath) return
  for (const name of ['config.toml', 'sessions', 'skills']) {
    const target = join(runtime.sharedHomePath, name)
    const link = join(runtime.homePath, name)
    if (!existsSync(target)) continue
    try {
      const existing = lstatSync(link)
      if (existing.isSymbolicLink() && readlinkSync(link) !== target) throw new Error('This shadow home uses another CODEX_HOME. Choose a different shadow home path.')
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      symlinkSync(target, link, name === 'config.toml' ? 'file' : 'dir')
    }
  }
}

interface InstancePaths { binaryPath: string; homePath?: string; sharedHomePath?: string }
function instancePaths(instance: ProviderInstance, launch: LaunchOptions, owner: boolean, seatHome?: string): InstancePaths {
  const home = launch.env.HOME ?? launch.env.USERPROFILE
  if (!home) throw new Error('Your provider environment has no home directory.')
  const baseHome = instance.homePath ? privatePath(instance.homePath, home, owner, seatHome) : undefined
  const shadowHome = instance.shadowHomePath ? privatePath(instance.shadowHomePath, home, owner, seatHome) : undefined
  if (shadowHome && (instance.provider !== 'codex' || !baseHome)) throw new Error('A Codex shadow home needs a CODEX_HOME path.')
  const binaryPath = instance.binaryPath.startsWith('~/') ? join(home, instance.binaryPath.slice(2)) : instance.binaryPath || (instance.provider === 'codex' ? 'codex' : 'claude')
  if ((binaryPath.includes('/') || binaryPath.includes('\\')) && !isAbsolute(binaryPath)) throw new Error('Use an absolute binary path or an executable name on PATH.')
  const result: InstancePaths = { binaryPath }
  const providerHome = shadowHome ?? baseHome
  if (providerHome) result.homePath = providerHome
  if (shadowHome && baseHome) result.sharedHomePath = baseHome
  return result
}

function authenticationStamp(provider: ProviderInstance['provider'], providerHome: string | undefined, env: NodeJS.ProcessEnv): number | null {
  const home = providerHome ?? join(env.HOME ?? env.USERPROFILE ?? '', provider === 'codex' ? '.codex' : '.claude')
  const authFile = join(home, provider === 'codex' ? 'auth.json' : '.credentials.json')
  try { return lstatSync(authFile).mtimeMs } catch { return null }
}

function instanceModelOptions(request: AgentRunRequest, runtime: ProviderRuntime): Pick<AgentRunRequest, 'reasoningEffort' | 'contextWindow' | 'fastMode'> {
  const profile = request.model ? runtime.modelProfiles?.[request.model] : undefined
  return {
    reasoningEffort: profile && request.reasoningEffort && !profile.reasoningLevels.includes(request.reasoningEffort) ? profile.defaultReasoningEffort : request.reasoningEffort,
    contextWindow: profile && request.contextWindow && !profile.contextWindows.includes(request.contextWindow) ? profile.defaultContextWindow : request.contextWindow,
    fastMode: profile ? profile.supportsFastMode && request.fastMode : request.fastMode,
  }
}
