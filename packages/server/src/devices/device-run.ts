import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import {
  LOCAL_DEVICE_HOST_ID,
  isDeviceRunActive,
  type DeviceControlHolder,
  type DeviceRun,
  type DeviceRunLog,
  type DeviceRunProfile,
  type DeviceSummary,
} from '@solus/contracts/device-types'
import { createLogger } from '../logger'
import { resolveHomePath } from '../platform/paths'
import { loadProjectConfig } from '../project-config/project-config'
import { DeviceDomainError, deviceErrorDetail } from './device-errors'
import type { DeviceManager } from './device-manager'
import { deviceHostEnvironment, findAndroidSdk } from './device-platform-probe'
import { runDeviceCommand, type DeviceCommandRunner } from './device-process'

const log = createLogger('devices', 'device-run.ts')

/**
 * Build and run (plan 016, S02): build a project's saved run profile in the
 * conversation's checkout, find the app it made, record it as a build,
 * install it on the chosen device and open it. Without a device, the run
 * stops once the build is recorded: a new build under Builds. Solus starts the build
 * process, so Cancel stops exactly that process and its children, never
 * anything found by name.
 *
 * Profiles come from the repository, so a command runs only after a person
 * on this host confirmed it once; a changed command asks again.
 */

const BUILD_TIMEOUT_MS = 30 * 60_000
const MAX_LOG_CHARS = 200_000
const MAX_RUNS = 10
const PUBLISH_INTERVAL_MS = 1_000
const MAX_ARTIFACT_MATCHES = 200

interface RunRecord {
  run: DeviceRun
  log: string
  truncated: boolean
  child: ChildProcess | null
  cancelled: boolean
  key: string
}

export type BuildSpawner = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess

export interface DeviceRunsDeps {
  manager: DeviceManager
  /** Commands a person confirmed, by hash. 0600 under the device root. */
  approvalsPath: string
  /** A state change to publish with the device snapshot. */
  changed: () => void
  spawn?: BuildSpawner
  /** Signals the build's process group. Tests pass a fake; nothing else is ever signalled. */
  killGroup?: (pid: number, signal: NodeJS.Signals) => void
  run?: DeviceCommandRunner
  env?: NodeJS.ProcessEnv
  now?: () => number
}

const approvalsSchema = z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(1_000)

// A process group of its own, so Cancel reaches xcodebuild's and Gradle's children.
const defaultSpawn: BuildSpawner = (command, args, options) => spawn(command, args, { ...options, detached: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false })

/** The command as a person reads it in a confirmation. */
export function commandLine(command: readonly string[]): string {
  return command.map((word) => (/^[\w./:=@+-]+$/.test(word) ? word : `'${word.replaceAll("'", `'"'"'`)}'`)).join(' ')
}

/** Files matching a profile's artifact pattern; `*` matches within one segment. */
export async function findArtifact(base: string, pattern: string): Promise<string | null> {
  let candidates = [base]
  for (const segment of pattern.split('/').filter((part) => part && part !== '.')) {
    const next: string[] = []
    if (!segment.includes('*')) {
      for (const candidate of candidates) next.push(join(candidate, segment))
    } else {
      const matcher = new RegExp(`^${segment.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`)
      for (const candidate of candidates) {
        for (const entry of await readdir(candidate).catch(() => [])) {
          if (matcher.test(entry) && next.length < MAX_ARTIFACT_MATCHES) next.push(join(candidate, entry))
        }
      }
    }
    candidates = next
  }
  let newest: { path: string; at: number } | null = null
  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => null)
    if (info && (!newest || info.mtimeMs > newest.at)) newest = { path: candidate, at: info.mtimeMs }
  }
  return newest?.path ?? null
}

/** The device fields of a run: the device it installs on, or none for a build only added under Builds. */
function runDevice(device: DeviceSummary | null) {
  return device
    ? { deviceHostId: device.deviceHostId, deviceId: device.deviceId, deviceName: device.name }
    : { deviceHostId: null, deviceId: null, deviceName: null }
}

export class DeviceRuns {
  private readonly records: RunRecord[] = []
  private approvals: Set<string>
  private publishTimer: ReturnType<typeof setTimeout> | null = null
  private readonly spawn: BuildSpawner
  private readonly killGroup: (pid: number, signal: NodeJS.Signals) => void
  private readonly run: DeviceCommandRunner
  private readonly env: NodeJS.ProcessEnv
  private readonly now: () => number

  constructor(private readonly deps: DeviceRunsDeps) {
    this.spawn = deps.spawn ?? defaultSpawn
    this.killGroup = deps.killGroup ?? ((pid, signal) => process.kill(-pid, signal))
    this.run = deps.run ?? runDeviceCommand
    const baseEnv = deps.env ?? process.env
    // The same tools the device host finds: Xcode's and the Android SDK's.
    this.env = { ...deviceHostEnvironment(baseEnv, findAndroidSdk({ env: baseEnv, hostPlatform: process.platform }).root), CI: '1', FORCE_COLOR: '0' }
    this.now = deps.now ?? Date.now
    this.approvals = this.loadApprovals()
  }

  list(): DeviceRun[] {
    return this.records.map((record) => ({ ...record.run }))
  }

  log(runId: string): DeviceRunLog {
    const record = this.record(runId)
    return { runId, text: record.log, truncated: record.truncated }
  }

  async start(request: { checkoutPath: string; profileName: string; deviceHostId?: string | undefined; deviceId?: string | undefined; sessionId?: string | undefined; approve?: boolean | undefined }, holder: DeviceControlHolder & { kind: 'user' }): Promise<DeviceRun> {
    const device = await this.installTarget(request)
    const checkoutPath = resolveHomePath(request.checkoutPath)
    if (!isAbsolute(checkoutPath) || !(await stat(checkoutPath).catch(() => null))?.isDirectory()) {
      throw new DeviceDomainError('invalid_request', 'The conversation\'s checkout is not on this host.')
    }
    const toplevel = await this.run('git', ['rev-parse', '--show-toplevel'], { cwd: checkoutPath, timeoutMs: 10_000 })
    const checkoutRoot = toplevel.code === 0 ? toplevel.stdout.trim() : checkoutPath
    const profile = (await loadProjectConfig(checkoutRoot))?.deviceRuns?.find((candidate) => candidate.name === request.profileName)
    if (!profile) throw new DeviceDomainError('invalid_request', `This project has no build profile named "${request.profileName}". Add it under Devices → Build & run.`)
    const cwd = resolve(checkoutRoot, profile.cwd)
    const inside = relative(checkoutRoot, cwd)
    if (inside.startsWith('..') || isAbsolute(inside)) throw new DeviceDomainError('invalid_request', `The build folder ${profile.cwd} is outside the project.`)
    if (device && device.platform !== profile.platform) throw new DeviceDomainError('invalid_request', `"${profile.name}" builds for ${profile.platform}, and ${device.name} is not.`)

    const approval = createHash('sha256').update(JSON.stringify([checkoutRoot, profile.cwd, profile.command])).digest('hex')
    if (!this.approvals.has(approval)) {
      if (!request.approve) {
        throw new DeviceDomainError('confirmation_required', `Run \`${commandLine(profile.command)}\` in ${profile.cwd === '.' ? basename(checkoutRoot) : profile.cwd}? This command comes from the project's .solus/config.json.`)
      }
      this.approvals.add(approval)
      await this.saveApprovals()
    }

    // A second click while this checkout builds this profile watches that build.
    const key = `${checkoutRoot}\u0000${profile.name}`
    const running = this.records.find((record) => record.key === key && isDeviceRunActive(record.run))
    if (running) return { ...running.run }

    const branch = await this.run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: checkoutRoot, timeoutMs: 10_000 })
    const record: RunRecord = {
      key,
      log: '',
      truncated: false,
      child: null,
      cancelled: false,
      run: {
        runId: `devrun_${randomUUID()}`,
        profileName: profile.name,
        checkout: basename(checkoutRoot),
        checkoutPath,
        branch: branch.code === 0 ? branch.stdout.trim() || null : null,
        ...runDevice(device),
        stage: 'building',
        lastLine: null,
        error: null,
        buildId: null,
        startedAt: this.now(),
        endedAt: null,
      },
    }
    this.records.unshift(record)
    this.records.splice(MAX_RUNS)
    this.deps.changed()
    void this.execute(record, profile, cwd, request.sessionId, holder)
    return { ...record.run }
  }

  /** The device a run installs on, or null when it only adds the build under Builds. */
  private async installTarget(request: { deviceHostId?: string | undefined; deviceId?: string | undefined }): Promise<DeviceSummary | null> {
    if (!request.deviceId) return null
    const deviceHostId = request.deviceHostId ?? LOCAL_DEVICE_HOST_ID
    if (deviceHostId !== LOCAL_DEVICE_HOST_ID) {
      throw new DeviceDomainError('action_unsupported', 'Build and run works only with devices connected to the Solus host itself.')
    }
    return (await this.deps.manager.resolveDevice(deviceHostId, request.deviceId)).device
  }

  cancel(runId: string): void {
    const record = this.record(runId)
    if (!isDeviceRunActive(record.run)) return
    record.cancelled = true
    const child = record.child
    if (!child?.pid) return
    // Only the process group this host started.
    const pid = child.pid
    try { this.killGroup(pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
    setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return
      try { this.killGroup(pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }, 5_000).unref?.()
    log.info('device_run_cancelled', { runId, pid: child.pid })
  }

  /** Stop every build this host started; the host is going away. */
  dispose(): void {
    for (const record of this.records) if (isDeviceRunActive(record.run)) this.cancel(record.run.runId)
  }

  private record(runId: string): RunRecord {
    const record = this.records.find((candidate) => candidate.run.runId === runId)
    if (!record) throw new DeviceDomainError('invalid_request', 'That run is no longer on this host.')
    return record
  }

  private async execute(record: RunRecord, profile: DeviceRunProfile, cwd: string, sessionId: string | undefined, holder: DeviceControlHolder & { kind: 'user' }): Promise<void> {
    const { manager } = this.deps
    try {
      const code = await this.build(record, profile, cwd)
      if (record.cancelled) return this.finish(record, 'cancelled', null)
      if (code !== 0) return this.finish(record, 'failed', `The build failed (exit ${code}). Open the log to see why.`)

      const artifact = await findArtifact(cwd, profile.artifact)
      if (!artifact) return this.finish(record, 'failed', `The build finished, but nothing matches ${profile.artifact} in ${profile.cwd}. Check the profile's output path.`)
      const build = await manager.addBuild(artifact, sessionId ?? record.run.runId, profile.appId || undefined)
      record.run.buildId = build.buildId
      if (!record.run.deviceHostId || !record.run.deviceId) return this.finish(record, 'done', null)
      record.run.stage = 'installing'
      this.deps.changed()

      let target = { deviceHostId: record.run.deviceHostId, deviceId: record.run.deviceId }
      const { device } = await manager.resolveDevice(target.deviceHostId, target.deviceId)
      if (!device.physical && sessionId) {
        // A simulator or emulator opens beside the conversation, booting if stopped.
        const preview = await manager.open({ sessionId, deviceHostId: device.deviceHostId, deviceId: device.deviceId, platform: device.platform }, 'user')
        target = { deviceHostId: preview.deviceHostId, deviceId: preview.deviceId }
      }
      const control = manager.control.state(target)
      if (control.lease && !(control.lease.holder.kind === 'user' && control.lease.holder.clientId === holder.clientId)) {
        throw new DeviceDomainError('control_busy', `${control.lease.holder.label} is using ${device.name}. The build is saved under Builds; run it when the device is free.`)
      }
      manager.acquireControl(target, holder)
      try {
        await manager.installBuild(target, build.buildId, holder)
      } finally {
        if (!control.lease) manager.releaseControl(target, holder)
      }
      this.finish(record, 'done', null)
    } catch (error) {
      this.finish(record, record.cancelled ? 'cancelled' : 'failed', record.cancelled ? null : deviceErrorDetail(error))
    }
  }

  private build(record: RunRecord, profile: DeviceRunProfile, cwd: string): Promise<number> {
    return new Promise((resolveExit) => {
      const [command, ...args] = profile.command
      let child: ChildProcess
      try {
        child = this.spawn(command!, args, { cwd: resolveHomePath(cwd), env: this.env })
      } catch (error) {
        this.append(record, `Could not start ${command}: ${deviceErrorDetail(error)}\n`)
        resolveExit(127)
        return
      }
      record.child = child
      log.info('device_run_started', { runId: record.run.runId, pid: child.pid, profile: profile.name })
      const timer = setTimeout(() => {
        this.append(record, `\nThe build ran longer than ${BUILD_TIMEOUT_MS / 60_000} minutes and was stopped.\n`)
        this.cancel(record.run.runId)
      }, BUILD_TIMEOUT_MS)
      timer.unref?.()
      child.stdout?.on('data', (chunk: Buffer) => this.append(record, chunk.toString()))
      child.stderr?.on('data', (chunk: Buffer) => this.append(record, chunk.toString()))
      child.once('error', (error) => {
        this.append(record, `Could not start ${command}: ${error.message}\n`)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        record.child = null
        resolveExit(code ?? 1)
      })
    })
  }

  private append(record: RunRecord, text: string): void {
    record.log += text
    if (record.log.length > MAX_LOG_CHARS) {
      record.log = record.log.slice(-MAX_LOG_CHARS)
      record.truncated = true
    }
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    if (lines.length) record.run.lastLine = lines.at(-1)!.slice(0, 200)
    // Log lines arrive many times a second; the snapshot goes out once a second.
    this.publishTimer ??= setTimeout(() => {
      this.publishTimer = null
      this.deps.changed()
    }, PUBLISH_INTERVAL_MS)
  }

  private finish(record: RunRecord, stage: DeviceRun['stage'], error: string | null): void {
    record.run.stage = stage
    record.run.error = error
    record.run.endedAt = this.now()
    log.info('device_run_finished', { runId: record.run.runId, stage, buildId: record.run.buildId })
    this.deps.changed()
  }

  private loadApprovals(): Set<string> {
    try {
      const parsed = approvalsSchema.safeParse(JSON.parse(readFileSync(this.deps.approvalsPath, 'utf8')))
      return new Set(parsed.success ? parsed.data : [])
    } catch {
      return new Set()
    }
  }

  private async saveApprovals(): Promise<void> {
    await mkdir(dirname(this.deps.approvalsPath), { recursive: true, mode: 0o700 })
    const temporary = `${this.deps.approvalsPath}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify([...this.approvals].slice(-1_000)), { mode: 0o600 })
    await rename(temporary, this.deps.approvalsPath)
  }
}
