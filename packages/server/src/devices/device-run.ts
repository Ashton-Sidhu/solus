import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { cp, mkdir, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { z } from 'zod'
import {
  DEVICE_RUN_TARGET_LABELS,
  LOCAL_DEVICE_HOST_ID,
  isDeviceRunActive,
  type DeviceControlHolder,
  type DeviceRun,
  type DeviceRunLog,
  type DeviceRunProfile,
  type DeviceRunStartRequest,
  type DeviceRunTarget,
  type DeviceControlState,
  type DeviceSummary,
} from '@solus/contracts/device-types'
import { createLogger } from '../logger'
import { resolveHomePath } from '../platform/paths'
import { DeviceDomainError, deviceErrorDetail } from './device-errors'
import type { DeviceManager } from './device-manager'
import { deviceHostEnvironment, findAndroidSdk } from './device-platform-probe'
import { runDeviceCommand, type DeviceCommandRunner } from './device-process'
import type { StoredDeviceBuild } from './device-builds'
import { connectDevelopmentDevice, disconnectDevelopmentDevice, type DeviceDevConnection } from './device-run-network'
import { androidBuildAppId } from './device-app-id'
import { DeviceRunState } from './device-run-state'
import { DeviceRunSources } from './device-run-source'
import { planDeviceRun } from './device-run-plan'
import { prepareDeviceRun } from './device-run-setup'
import { scanDeviceProject } from './device-project'
import { DEV_SERVER_PORT, DEV_SERVER_URL, devApp, probeDevServer, servesCheckout, type DevApp, type DevServerProbe } from './device-dev-server'
import { explainSigningFailure } from './device-signing'

const log = createLogger('devices', 'device-run.ts')

/**
 * Run app has two paths. A production build runs Release in an owned
 * checkout at a recorded commit for a target type; the client then installs
 * that one output on as many devices as it likes. A dev run builds nothing:
 * it joins or starts this project's Metro, and each request opens the debug
 * app already on one more simulator against it.
 * Stop signals only the process group this host started for that run.
 * Repository commands require approval, remembered by their exact hash.
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
  /** `adb reverse` mappings this run made for a dev server it owns. */
  connections: DeviceDevConnection[]
  /** A dev run's app, for each simulator it opens. */
  dev: { appFolder: string; usesExpo: boolean } | null
}

/** What a target stands for when build profiles are matched. The build installs nothing. */
function targetDevice(target: DeviceRunTarget): DeviceSummary {
  return { deviceHostId: LOCAL_DEVICE_HOST_ID, deviceId: target, platform: target === 'android' ? 'android' : 'ios', name: DEVICE_RUN_TARGET_LABELS[target], version: '', booted: true, physical: target === 'ios-device' }
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
  probeDevServer?: () => Promise<DevServerProbe>
  fetch?: typeof fetch
  sources?: Pick<DeviceRunSources, 'prepare'>
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

export class DeviceRuns {
  private readonly records: RunRecord[] = []
  private readonly state: DeviceRunState
  private approvals: Set<string>
  private publishTimer: ReturnType<typeof setTimeout> | null = null
  private readonly spawn: BuildSpawner
  private readonly killGroup: (pid: number, signal: NodeJS.Signals) => void
  private readonly run: DeviceCommandRunner
  private readonly env: NodeJS.ProcessEnv
  private readonly now: () => number
  private readonly sources: Pick<DeviceRunSources, 'prepare'>
  private readonly probeDevServer: () => Promise<DevServerProbe>
  private readonly fetch: typeof fetch
  private admission: Promise<void> = Promise.resolve()

  constructor(private readonly deps: DeviceRunsDeps) {
    this.spawn = deps.spawn ?? defaultSpawn
    this.killGroup = deps.killGroup ?? ((pid, signal) => process.kill(-pid, signal))
    this.run = deps.run ?? runDeviceCommand
    const baseEnv = deps.env ?? process.env
    // The same tools the device host finds: Xcode's and the Android SDK's.
    this.env = { ...deviceHostEnvironment(baseEnv, findAndroidSdk({ env: baseEnv, hostPlatform: process.platform }).root), CI: '1', FORCE_COLOR: '0' }
    this.now = deps.now ?? Date.now
    this.fetch = deps.fetch ?? fetch
    this.probeDevServer = deps.probeDevServer ?? (() => probeDevServer(this.fetch))
    this.approvals = this.loadApprovals()
    this.sources = deps.sources ?? new DeviceRunSources(join(dirname(deps.approvalsPath), 'run-app'), this.run, this.env)
    this.state = new DeviceRunState(join(dirname(deps.approvalsPath), 'run-app.json'))
    for (const stored of this.state.load()) {
      if (isDeviceRunActive(stored.run)) {
        stored.run.stage = 'failed'
        stored.run.error = 'The host restarted. Run the app again.'
        stored.run.endedAt = this.now()
      }
      this.records.push({ ...stored, child: null, cancelled: false, connections: [], dev: null })
    }
  }

  list(): DeviceRun[] {
    return this.records.map((record) => ({ ...record.run }))
  }

  log(runId: string): DeviceRunLog {
    const record = this.record(runId)
    return { runId, text: record.log, truncated: record.truncated }
  }

  start(request: DeviceRunStartRequest, holder: DeviceControlHolder & { kind: 'user' }): Promise<DeviceRun> {
    const result = this.admission.then(() => this.startOwned(request, holder))
    this.admission = result.then(() => {}, () => {})
    return result
  }

  private async startOwned(request: DeviceRunStartRequest, holder: DeviceControlHolder & { kind: 'user' }): Promise<DeviceRun> {
    if (!this.deps.manager.settings().enabled) throw new DeviceDomainError('feature_disabled', 'Enable device support before running the app.')
    if (request.mode === 'dev') return this.startDev(request, holder)
    const { target } = request
    if (!target) throw new DeviceDomainError('invalid_request', 'Choose what to build for.')
    const device = targetDevice(target)
    const { checkoutPath, projectRoot } = await this.projectRoot(request.checkoutPath)
    const { source, mode } = request
    const busy = this.runningForProject(projectRoot, request)
    if (busy) return busy
    const selected = await this.sources.prepare(projectRoot, source, request.branch)
    const checkoutRoot = selected.path
    const { profile, cwd, appFolder, automatic, info } = await planDeviceRun(projectRoot, checkoutRoot, request, device)
    const commit = selected.commit
    const approval = createHash('sha256').update(JSON.stringify([projectRoot, profile.cwd, profile.command, mode])).digest('hex')
    if (!this.approvals.has(approval)) {
      if (!request.approve) {
        throw new DeviceDomainError('confirmation_required', `Run \`${commandLine(profile.command)}\` in ${profile.cwd === '.' ? basename(checkoutRoot) : profile.cwd}? This command comes from the project's .solus/config.json.`)
      }
      this.approvals.add(approval)
      await this.saveApprovals()
    }

    const branch = await this.run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: resolveHomePath(projectRoot), timeoutMs: 10_000 })
    const record: RunRecord = {
      log: '',
      truncated: false,
      child: null,
      cancelled: false,
      connections: [],
      dev: null,
      run: {
        runId: `devrun_${randomUUID()}`,
        profileName: profile.name,
        source, mode, target, commit,
        checkout: basename(projectRoot),
        checkoutPath,
        projectPath: projectRoot,
        branch: request.branch ?? (source === 'main' ? 'main' : branch.code === 0 ? branch.stdout.trim() || null : null),
        deviceHostId: null, deviceId: null, deviceName: null,
        stage: 'preparing',
        lastLine: null,
        error: null,
        buildId: null,
        startedAt: this.now(),
        endedAt: null,
      },
    }
    this.remember(record)
    this.changed()
    void this.execute(record, profile, cwd, request.sessionId, info.usesExpo ?? false, checkoutRoot, automatic, selected.hasChangedSource, appFolder)
    return { ...record.run }
  }

  /** The project as it is on disk, not an owned checkout: the dev server reloads what the person and agents edit. */
  private async startDev(request: DeviceRunStartRequest, holder: DeviceControlHolder & { kind: 'user' }): Promise<DeviceRun> {
    const device = await this.installTarget(request)
    if (device.physical) throw new DeviceDomainError('action_unsupported', 'A dev run uses a simulator or emulator. Use a production build for a phone.')
    const { checkoutPath, projectRoot } = await this.projectRoot(request.checkoutPath)
    const busy = this.records.find((record) => record.run.projectPath === projectRoot && isDeviceRunActive(record.run))
    // The dev server this host runs for the project takes one more simulator.
    if (busy?.dev) {
      if (busy.run.stage !== 'running') throw new DeviceDomainError('invalid_request', 'The dev server is still starting. Open the app on this simulator when it runs.')
      await this.openOnSimulator(busy, busy.dev, device, request.sessionId, holder)
      return { ...busy.run }
    }
    if (busy) throw new DeviceDomainError('invalid_request', 'Stop the current build before you start the dev server.')
    if (this.records.filter((record) => isDeviceRunActive(record.run)).length >= MAX_RUNS) throw new DeviceDomainError('invalid_request', 'Stop an app run before starting another.')
    const info = await scanDeviceProject(checkoutPath)
    const manifest = info.markers.filter((marker) => marker.endsWith('package.json')).at(-1)
    if (!(info.usesExpo || info.usesReactNative) || manifest === undefined) {
      throw new DeviceDomainError('action_unsupported', 'A dev run needs an Expo or React Native app. Use a production build for this project.')
    }
    // The scan goes by depth, so the last manifest is the app's, not a monorepo root's.
    const appFolder = join(checkoutPath, dirname(manifest))
    const command = await this.devServerCommand(checkoutPath, info.usesExpo ?? false)
    if (command) {
      const approval = createHash('sha256').update(JSON.stringify([projectRoot, appFolder, command, 'dev'])).digest('hex')
      if (!this.approvals.has(approval)) {
        if (!request.approve) throw new DeviceDomainError('confirmation_required', `Start the dev server with \`${commandLine(command)}\` in ${relative(dirname(checkoutPath), appFolder)}?`)
        this.approvals.add(approval)
        await this.saveApprovals()
      }
    }

    const [head, branch] = await Promise.all([
      this.run('git', ['rev-parse', 'HEAD'], { cwd: checkoutPath, timeoutMs: 10_000 }),
      this.run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: checkoutPath, timeoutMs: 10_000 }),
    ])
    const record: RunRecord = {
      log: '',
      truncated: false,
      child: null,
      cancelled: false,
      connections: [],
      dev: { appFolder, usesExpo: info.usesExpo ?? false },
      run: {
        runId: `devrun_${randomUUID()}`,
        profileName: 'Dev server',
        source: request.source, mode: 'dev', target: null, commit: head.code === 0 ? head.stdout.trim() : '',
        checkout: basename(projectRoot),
        checkoutPath,
        projectPath: projectRoot,
        branch: branch.code === 0 ? branch.stdout.trim() || null : null,
        deviceHostId: device.deviceHostId, deviceId: device.deviceId, deviceName: device.name,
        stage: 'starting',
        lastLine: null,
        error: null,
        buildId: null,
        startedAt: this.now(),
        endedAt: null,
      },
    }
    this.remember(record)
    this.changed()
    void this.executeDev(record, record.dev!, device, command, request.sessionId, holder)
    return { ...record.run }
  }

  /** The command that starts Metro when the port is free; null when this project's Metro already runs there. */
  private async devServerCommand(checkoutPath: string, usesExpo: boolean): Promise<string[] | null> {
    const server = await this.probeDevServer()
    if (server.state === 'other') throw new DeviceDomainError('command_failed', `Another process uses port ${DEV_SERVER_PORT}. Stop it, or start this project's dev server there.`)
    if (server.state === 'running') {
      if (await servesCheckout(server.projectRoot, checkoutPath)) return null
      throw new DeviceDomainError('command_failed', `The dev server on port ${DEV_SERVER_PORT} serves ${server.projectRoot}. Stop it, or choose that project.`)
    }
    return usesExpo ? ['npx', 'expo', 'start', '--localhost', '--port', String(DEV_SERVER_PORT)] : ['npx', 'react-native', 'start', '--port', String(DEV_SERVER_PORT)]
  }

  private async executeDev(record: RunRecord, dev: { appFolder: string; usesExpo: boolean }, device: DeviceSummary, command: string[] | null, sessionId: string | undefined, holder: DeviceControlHolder & { kind: 'user' }): Promise<void> {
    try {
      if (command) await this.serve(record, command, dev.appFolder)
      else this.append(record, `Using the dev server on port ${DEV_SERVER_PORT}.\n`)
      if (record.cancelled) return this.finish(record, 'cancelled', null)
      await this.openOnSimulator(record, dev, device, sessionId, holder)
      if (record.cancelled) return this.finish(record, 'cancelled', null)
      // A joined server is not this host's to stop, so the run ends once the app opens.
      if (command) { record.run.stage = 'running'; this.changed() }
      else this.finish(record, 'done', null)
    } catch (error) {
      this.stopChild(record)
      this.finish(record, record.cancelled ? 'cancelled' : 'failed', record.cancelled ? null : deviceErrorDetail(error))
    }
  }

  /** Open the debug app already on a simulator against the dev server. Throws when it is not there. */
  private async openOnSimulator(record: RunRecord, dev: { appFolder: string; usesExpo: boolean }, initial: DeviceSummary, sessionId: string | undefined, holder: DeviceControlHolder & { kind: 'user' }): Promise<void> {
    const { target, device } = await this.openTarget(record, { deviceHostId: initial.deviceHostId, deviceId: initial.deviceId }, sessionId, holder)
    if (record.cancelled) return
    const connection = await connectDevelopmentDevice(device, this.run, this.env)
    // A joined server outlives this run, so its connection stays too.
    if (connection && record.child) record.connections.push(connection)
    const app = await devApp(dev.appFolder, device.platform, dev.usesExpo, this.fetch)
    if (!(await this.isInstalled(device, app.appId))) {
      throw new DeviceDomainError('invalid_request', `${app.appId} is not on ${device.name}. Install a debug build once (for example \`npx expo run:${device.platform}\`), then run again.`)
    }
    if (record.cancelled) return
    await this.openDevApp(target, device, app, holder)
    this.append(record, `Opened ${app.appId} on ${device.name}.\n`)
  }

  private async isInstalled(device: DeviceSummary, appId: string): Promise<boolean> {
    if (device.platform === 'ios') return (await this.run('xcrun', ['simctl', 'get_app_container', device.deviceId, appId], { timeoutMs: 15_000, env: this.env })).code === 0
    const result = await this.run('adb', ['-s', device.deviceId, 'shell', 'pm', 'path', appId], { timeoutMs: 15_000, env: this.env })
    return result.code === 0 && result.stdout.includes('package:')
  }

  /** A dev client opens its URL; a plain debug build loads from Metro on launch, so it restarts. */
  private async openDevApp(target: { deviceHostId: string; deviceId: string }, device: DeviceSummary, app: DevApp, holder: DeviceControlHolder & { kind: 'user' }): Promise<void> {
    const { manager } = this.deps
    const control = this.availableControl(target, device.name, holder)
    manager.acquireControl(target, holder)
    try {
      if (app.devClientScheme) {
        const opened = await manager.action(target, { type: 'openUrl', url: `${app.devClientScheme}://expo-development-client/?url=${encodeURIComponent(DEV_SERVER_URL)}` }, holder).then(() => true, () => false)
        if (opened) return
      }
      await manager.action(target, { type: 'terminateApp', appId: app.appId }, holder).catch(() => {})
      await manager.action(target, { type: 'launchApp', appId: app.appId }, holder)
    } finally {
      if (!control.lease) manager.releaseControl(target, holder)
    }
  }

  /** A second click on the same build watches it; anything else waits for it. */
  private runningForProject(projectRoot: string, request: DeviceRunStartRequest): DeviceRun | null {
    const busy = this.records.find((record) => record.run.projectPath === projectRoot && isDeviceRunActive(record.run))
    if (busy) {
      const sameSource = busy.run.source === request.source && (request.branch ? busy.run.branch === request.branch : request.source !== 'main' || busy.run.branch === 'main')
      if (busy.run.mode === 'device' && sameSource && busy.run.target === request.target) return { ...busy.run }
      throw new DeviceDomainError('invalid_request', 'Stop the current app run before you start another.')
    }
    if (this.records.filter((record) => isDeviceRunActive(record.run)).length >= MAX_RUNS) throw new DeviceDomainError('invalid_request', 'Stop an app run before starting another.')
    return null
  }

  private async projectRoot(rawPath: string): Promise<{ checkoutPath: string; projectRoot: string }> {
    const checkoutPath = resolveHomePath(rawPath)
    if (!isAbsolute(checkoutPath) || !(await stat(checkoutPath).catch(() => null))?.isDirectory()) {
      throw new DeviceDomainError('invalid_request', 'The project is not on this host.')
    }
    const toplevel = await this.run('git', ['rev-parse', '--show-toplevel'], { cwd: checkoutPath, timeoutMs: 10_000 })
    return { checkoutPath, projectRoot: toplevel.code === 0 ? toplevel.stdout.trim() : checkoutPath }
  }

  private remember(record: RunRecord): void {
    const { checkoutPath, source, mode, branch, target } = record.run
    const same = (candidate: RunRecord) => candidate.run.checkoutPath === checkoutPath && candidate.run.source === source && candidate.run.branch === branch && candidate.run.mode === mode && candidate.run.target === target
    // The latest useful output stays available when a retry fails.
    const previous = this.records.find(same)
    record.run.buildId = previous?.run.buildId ?? null
    if (previous?.run.outputCommit) record.run.outputCommit = previous.run.outputCommit
    for (let index = this.records.length - 1; index >= 0; index--) {
      const candidate = this.records[index]!
      if (same(candidate) && !isDeviceRunActive(candidate.run)) this.records.splice(index, 1)
    }
    this.records.unshift(record)
    // Keep running processes reachable by Stop, even when other projects run.
    for (let index = this.records.length - 1; index >= MAX_RUNS; index--) {
      if (!isDeviceRunActive(this.records[index]!.run)) this.records.splice(index, 1)
    }
  }

  /** A dev run uses a simulator on the selected Solus host. */
  private async installTarget(request: { deviceHostId?: string | undefined; deviceId?: string | undefined }): Promise<DeviceSummary> {
    if (!request.deviceId) throw new DeviceDomainError('invalid_request', 'Choose a simulator before running the app.')
    const deviceHostId = request.deviceHostId ?? LOCAL_DEVICE_HOST_ID
    if (deviceHostId !== LOCAL_DEVICE_HOST_ID) {
      throw new DeviceDomainError('action_unsupported', 'A dev run works only with simulators on the Solus host itself.')
    }
    return (await this.deps.manager.resolveDevice(deviceHostId, request.deviceId)).device
  }

  cancel(runId: string): void {
    const record = this.record(runId)
    if (!isDeviceRunActive(record.run)) return
    record.cancelled = true
    record.run.stage = 'stopping'
    this.changed()
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
    if (this.publishTimer) { clearTimeout(this.publishTimer); this.publishTimer = null }
    for (const record of this.records) if (isDeviceRunActive(record.run)) this.cancel(record.run.runId)
  }

  private record(runId: string): RunRecord {
    const record = this.records.find((candidate) => candidate.run.runId === runId)
    if (!record) throw new DeviceDomainError('invalid_request', 'That run is no longer on this host.')
    return record
  }

  private async execute(record: RunRecord, profile: DeviceRunProfile, cwd: string, sessionId: string | undefined, usesExpo: boolean, checkoutRoot: string, automatic: boolean, hasChangedSource: boolean, appFolder: string): Promise<void> {
    try {
      profile = await prepareDeviceRun({ checkoutRoot, cwd, appFolder, profile, usesExpo, automatic, hasChangedSource,
        cancelled: () => record.cancelled,
        command: (command, directory) => this.build(record, { ...profile, command }, directory),
      })
      if (record.cancelled) return this.finish(record, 'cancelled', null)
      record.run.stage = 'building'
      this.changed()
      const code = await this.build(record, profile, cwd)
      if (record.cancelled) return this.finish(record, 'cancelled', null)
      if (code !== 0) return this.finish(record, 'failed', explainSigningFailure(record.log) ?? `The build failed (exit ${code}). Open the log to see why.`)

      await this.recordOutput(record, profile, cwd, sessionId)
      this.finish(record, record.cancelled ? 'cancelled' : 'done', null)
    } catch (error) {
      this.stopChild(record)
      this.finish(record, record.cancelled ? 'cancelled' : 'failed', record.cancelled ? null : deviceErrorDetail(error))
    }
  }

  private async recordOutput(record: RunRecord, profile: DeviceRunProfile, cwd: string, sessionId: string | undefined): Promise<StoredDeviceBuild> {
    const artifact = await findArtifact(cwd, profile.artifact)
    if (!artifact) throw new DeviceDomainError('command_failed', `The build finished, but nothing matches ${profile.artifact} in ${profile.cwd}. Check the artifact path in the project's .solus/config.json.`)
    let appId = profile.appId || undefined
    if (!appId && profile.platform === 'android') appId = await androidBuildAppId(artifact, this.env.ANDROID_HOME ?? null, this.run) ?? undefined
    let output = artifact
    let build: StoredDeviceBuild
    try {
      if (profile.platform === 'ios') {
        output = join(dirname(this.deps.approvalsPath), 'outputs', record.run.runId, basename(artifact))
        await mkdir(dirname(output), { recursive: true, mode: 0o700 })
        await cp(await realpath(artifact), output, { recursive: true, verbatimSymlinks: true })
      }
      build = await this.deps.manager.addBuild(output, sessionId ?? record.run.runId, appId)
    } catch (error) {
      if (output !== artifact) await rm(dirname(output), { recursive: true, force: true })
      throw error
    }
    record.run.buildId = build.buildId
    record.run.outputCommit = record.run.commit
    return build
  }

  private availableControl(target: { deviceHostId: string; deviceId: string }, name: string, holder: DeviceControlHolder & { kind: 'user' }): DeviceControlState {
    const control = this.deps.manager.control.state(target)
    if (control.lease && !(control.lease.holder.kind === 'user' && control.lease.holder.clientId === holder.clientId)) {
      throw new DeviceDomainError('control_busy', `${control.lease.holder.label} is using ${name}. Retry when the device is free.`)
    }
    return control
  }

  private async openTarget(record: RunRecord, initialTarget: { deviceHostId: string; deviceId: string }, sessionId: string | undefined, holder: DeviceControlHolder & { kind: 'user' }): Promise<{ target: { deviceHostId: string; deviceId: string }; device: DeviceSummary }> {
    const { manager } = this.deps
    let target = initialTarget
    let { device } = await manager.resolveDevice(target.deviceHostId, target.deviceId)
    const control = this.availableControl(target, device.name, holder)
    if (!device.booted && !device.physical) {
      manager.acquireControl(target, holder)
      try { device = await manager.bootForRun(target, holder) }
      finally { if (!control.lease) manager.releaseControl(target, holder) }
      target = { deviceHostId: device.deviceHostId, deviceId: device.deviceId }
    }
    if (!record.cancelled && !device.physical && sessionId) {
      const preview = await manager.open({ sessionId, deviceHostId: device.deviceHostId, deviceId: device.deviceId, platform: device.platform, boot: false }, 'user')
      target = { deviceHostId: preview.deviceHostId, deviceId: preview.deviceId }
    }
    return { target, device }
  }

  /** Resolves once Metro accepts connections. A later exit fails the run. */
  private serve(record: RunRecord, command: string[], cwd: string): Promise<void> {
    const [executable, ...args] = command
    const child = this.spawn(executable!, args, { cwd: resolveHomePath(cwd), env: this.env })
    record.child = child
    log.info('device_dev_server_started', { runId: record.run.runId, pid: child.pid, checkoutPath: cwd })
    return new Promise<void>((resolveReady, rejectReady) => {
      let ready = false
      let output = ''
      const timer = setTimeout(() => {
        this.stopChild(record)
        rejectReady(new DeviceDomainError('command_failed', 'The dev server did not become ready. Open Details to see why.'))
      }, 120_000)
      timer.unref?.()
      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        this.append(record, text)
        output = (output + text).slice(-20_000)
        if (!ready && /Waiting on\s+\S+|Dev server ready|Loading dependency graph, done/.test(output)) {
          ready = true
          clearTimeout(timer)
          resolveReady()
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => this.append(record, chunk.toString()))
      child.once('error', (error) => { clearTimeout(timer); rejectReady(error) })
      child.once('close', (code) => {
        clearTimeout(timer)
        record.child = null
        const error = record.cancelled ? null : `The dev server stopped (exit ${code ?? 1}).`
        if (!ready) rejectReady(new DeviceDomainError('command_failed', error ?? 'Stopped.'))
        else if (isDeviceRunActive(record.run)) this.finish(record, record.cancelled ? 'cancelled' : 'failed', error)
      })
    })
  }

  private stopChild(record: RunRecord): void {
    const child = record.child
    if (!child?.pid) return
    const pid = child.pid
    try { this.killGroup(pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
    setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return
      try { this.killGroup(pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }, 5_000).unref?.()
  }

  private build(record: RunRecord, profile: DeviceRunProfile, cwd: string): Promise<number> {
    if (record.cancelled) return Promise.resolve(130)
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
      this.changed(false)
    }, PUBLISH_INTERVAL_MS)
  }

  private finish(record: RunRecord, stage: DeviceRun['stage'], error: string | null): void {
    for (const connection of record.connections.splice(0)) {
      void disconnectDevelopmentDevice(connection, this.run, this.env).catch((cause) => {
        this.append(record, `Connection cleanup: ${deviceErrorDetail(cause)}\n`)
      })
    }
    record.run.stage = stage
    record.run.error = stage === 'cancelled' ? record.run.error ?? error : error
    record.run.endedAt = this.now()
    log.info('device_run_finished', { runId: record.run.runId, stage, buildId: record.run.buildId })
    this.changed()
  }

  private changed(persist = true): void {
    this.deps.changed()
    if (!persist) return
    void this.state.save(this.records.map(({ run, log: text, truncated }) => ({ run, log: text, truncated }))).catch((error) => {
      log.error('device_run_state_save_failed', { error: deviceErrorDetail(error) })
    })
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
