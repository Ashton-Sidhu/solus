import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeviceHostSummary, DeviceRun, DeviceRunProfile } from '@solus/contracts/device-types'
import { DeviceBuildStore } from '@solus/server/devices/device-builds'
import { DeviceDomainError } from '@solus/server/devices/device-errors'
import type { DeviceHost, DeviceHostReady } from '@solus/server/devices/device-host'
import { DeviceHubClient } from '@solus/server/devices/device-hub-client'
import { DeviceManager } from '@solus/server/devices/device-manager'
import type { DeviceCommandRunner } from '@solus/server/devices/device-process'
import { DeviceRunState } from '@solus/server/devices/device-run-state'
import { DeviceRuns, findArtifact, type BuildSpawner } from '@solus/server/devices/device-run'
import type { DevServerProbe } from '@solus/server/devices/device-dev-server'
import { DeviceSettingsStore } from '@solus/server/devices/device-settings-store'

/**
 * Build and run (plan 016, S02). The rules: a command from the repository
 * runs only after a person confirmed it once on this host; the app built is
 * the one installed; a failed build says so; Cancel signals only the process
 * the host started. A dev run builds nothing: it joins this project's dev
 * server or starts one, and never adopts another project's server.
 */

const devicectlJson = JSON.stringify({ result: { devices: [{
  identifier: 'CORE-1',
  connectionProperties: { pairingState: 'paired', tunnelState: 'connected' },
  deviceProperties: { name: 'Ash iPhone', osVersionNumber: '26.0', developerModeStatus: 'enabled' },
  hardwareProperties: { udid: 'PHONE-1', platform: 'iOS', deviceType: 'iPhone', reality: 'physical' },
}] } })

const profile: DeviceRunProfile = {
  name: 'iOS device',
  platform: 'ios',
  target: 'device',
  cwd: 'ios',
  command: ['xcodebuild', '-scheme', 'App', 'build'],
  artifact: 'build/Debug-iphoneos/*.app',
}

class FakeChild extends EventEmitter {
  pid = 4242
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill() { return true }
  exit(code: number) {
    this.exitCode = code
    this.emit('close', code)
  }
}

// What Expo's dev server answers for the manifest: the app config, dynamic config included.
const expoManifest = (async () => Response.json({ extra: { expoClient: { slug: 'demo', ios: { bundleIdentifier: 'dev.solus.demo' } } } })) as unknown as typeof fetch

function setup(expo = false, options: { devServer?: (checkout: string) => DevServerProbe; appInstalled?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'solus-run-'))
  const checkout = join(root, 'checkout')
  mkdirSync(join(checkout, '.solus'), { recursive: true })
  mkdirSync(join(checkout, 'ios'), { recursive: true })
  writeFileSync(join(checkout, '.solus', 'config.json'), JSON.stringify({ version: 1, deviceRuns: [profile] }))
  if (expo) {
    writeFileSync(join(checkout, 'package.json'), JSON.stringify({ dependencies: { expo: '1' } }))
    mkdirSync(join(checkout, 'node_modules'))
  }
  const commands: string[] = []
  const run: DeviceCommandRunner = async (command, args) => {
    commands.push([command, ...args].join(' '))
    if (command === 'sh') return { code: 0, stdout: devicectlJson, stderr: '' }
    if (command === 'plutil') return { code: 0, stdout: args.includes('CFBundleIdentifier') ? 'dev.solus.demo' : '["iPhoneOS"]', stderr: '' }
    if (command === 'git') return { code: 1, stdout: '', stderr: 'not a repository' }
    if (args[1] === 'get_app_container' && options.appInstalled === false) return { code: 2, stdout: '', stderr: 'No such app' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const ready: DeviceHostReady = { hubOrigin: 'http://hub', nodePath: '/usr/bin/node', run, helpers: { serveSimAxSettings: null, serveSimCli: null } }
  const summary: DeviceHostSummary = { deviceHostId: 'local', kind: 'local', label: 'This machine', platforms: [{ platform: 'ios', available: true }, { platform: 'android', available: false }], hubInstalled: true, agentDeviceInstalled: false }
  const host: DeviceHost = {
    deviceHostId: 'local', kind: 'local',
    summary: async () => summary,
    platformAvailability: async (platform) => summary.platforms.find((entry) => entry.platform === platform)!,
    ensureReady: async () => ready,
    ensureAgentReady: async () => ({ ...ready, agentDevice: { baseUrl: 'http://agent', token: 't' } }),
    current: () => ready, updateTool: async () => {}, stopAgent: async () => {}, stop: async () => {},
  }
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ enabled: true }))
  const manager = new DeviceManager({
    settings: new DeviceSettingsStore(join(root, 'settings.json')),
    localHost: host,
    hub: new DeviceHubClient((async () => Response.json({ simulators: [{ id: 'SIM-1', name: 'iPhone 17', version: 'iOS 26.0', platform: 'ios', booted: true, physical: false }, { id: 'SIM-2', name: 'iPad Air', version: 'iOS 26.0', platform: 'ios', booted: true, physical: false }], emulators: [], errors: [] })) as unknown as typeof fetch),
    publish: () => {}, surfaceRequested: () => {}, storeImage: async () => ({ assetId: 'x.png' }),
    builds: new DeviceBuildStore({ path: join(root, 'builds.json'), run }),
  })
  const children: FakeChild[] = []
  const spawned: { command: string; args: string[]; cwd: string }[] = []
  const spawn: BuildSpawner = (command, args, options) => {
    spawned.push({ command, args, cwd: options.cwd })
    const child = new FakeChild()
    child.pid += children.length
    children.push(child)
    // SAFETY: the runner uses only the ChildProcess members FakeChild provides.
    return child as unknown as ChildProcess
  }
  const signals: [number, string][] = []
  const listeners = new Set<() => void>()
  const runs = new DeviceRuns({ manager, approvalsPath: join(root, 'approvals.json'), changed: () => { for (const listener of listeners) listener() }, probeDevServer: async () => options.devServer?.(checkout) ?? { state: 'free' }, fetch: expoManifest, sources: { prepare: async () => ({ path: checkout, commit: 'a'.repeat(40), hasChangedCommit: false }) }, spawn, run, killGroup: (pid, signal) => { signals.push([pid, signal]) } })
  const user = { kind: 'user' as const, clientId: 'c1', label: 'Ash' }
  const request = { source: 'conversation' as const, mode: 'device' as const, target: 'ios-device' as const, checkoutPath: checkout, profileName: 'iOS device' }
  function waitStage(stage: string) {
    return new Promise<void>((resolveStage) => {
      const check = () => { if (runs.list()[0]?.stage === stage) { listeners.delete(check); resolveStage() } }
      listeners.add(check)
      check()
    })
  }
  return { root, checkout, manager, runs, user, request, children, spawned, signals, commands, waitStage }
}

describe('build and run', () => {
  test('a command from the repository runs only after a person confirms it once', async () => {
    const { manager, runs, user, request, spawned, root, checkout, waitStage } = setup()
    await manager.list()
    const first = await runs.start(request, user).catch((cause: unknown) => cause)
    expect((first as DeviceDomainError).code).toBe('confirmation_required')
    expect((first as DeviceDomainError).detail).toContain('xcodebuild -scheme App -configuration Release build')
    expect(spawned).toHaveLength(0)
    await runs.start({ ...request, approve: true }, user)
    await waitStage('building')
    expect(spawned).toEqual([{ command: 'xcodebuild', args: ['-scheme', 'App', '-configuration', 'Release', 'build'], cwd: join(checkout, 'ios') }])
    // Remembered on this host: a new runner reads the same approvals.
    const again = new DeviceRuns({ manager, approvalsPath: join(root, 'approvals.json'), changed: () => {}, sources: { prepare: async () => ({ path: checkout, commit: 'a'.repeat(40), hasChangedCommit: false }) }, spawn: () => { throw new Error('spawned') }, run: async () => ({ code: 1, stdout: '', stderr: '' }), killGroup: () => {} })
    const second = await again.start(request, user).catch((cause: unknown) => cause)
    expect((second as DeviceDomainError | undefined)?.code).not.toBe('confirmation_required')
  })

  test('an active run cannot be reused for a different selected branch', async () => {
    const { manager, runs, user, request, children, waitStage } = setup()
    await manager.list()
    const first = await runs.start({ ...request, branch: 'feature/one', approve: true }, user)
    await waitStage('building')
    expect(first.branch).toBe('feature/one')
    const repeated = await runs.start({ ...request, branch: 'feature/one', approve: true }, user)
    expect(repeated.runId).toBe(first.runId)
    await expect(runs.start({ ...request, branch: 'feature/two', approve: true }, user)).rejects.toThrow('Stop the current app run')
    runs.cancel(first.runId)
    children[0]!.exit(143)
    await waitStage('cancelled')
  })

  test('a finished build is recorded for install on any number of devices, and installs on none by itself', async () => {
    const { manager, runs, user, request, children, checkout, commands, waitStage, root } = setup()
    await manager.list()
    const run = await runs.start({ ...request, approve: true }, user)
    await waitStage('building')
    const app = join(checkout, 'ios', 'build', 'Release-iphoneos', 'Demo.app')
    mkdirSync(app, { recursive: true })
    writeFileSync(join(app, 'AppBinary'), 'tested commit')
    children[0]!.stdout.emit('data', Buffer.from('Compiling…\n** BUILD SUCCEEDED **\n'))
    children[0]!.exit(0)
    await waitStage('done')
    const done = runs.list()[0]!
    expect([done.stage, done.error]).toEqual(['done', null])
    expect(done.lastLine).toBe('** BUILD SUCCEEDED **')
    expect(manager.state().builds[0]!.buildId).toBe(done.buildId!)
    expect(manager.state().builds[0]).toMatchObject({ platform: 'ios', name: 'Demo.app' })
    expect(commands.some((command) => command.includes('install app'))).toBe(false)
    writeFileSync(join(app, 'AppBinary'), 'failed retry changed the build folder')
    expect(readFileSync(join(root, 'outputs', run.runId, 'Demo.app', 'AppBinary'), 'utf8')).toBe('tested commit')
    expect(runs.log(run.runId).text).toContain('BUILD SUCCEEDED')
  })

  test('a production build needs a target before it starts', async () => {
    const { runs, user, request, spawned } = setup()
    const { target: _target, ...untargeted } = request
    const error = await runs.start(untargeted, user).catch((cause: unknown) => cause)
    expect((error as DeviceDomainError).detail).toBe('Choose what to build for.')
    expect(spawned).toHaveLength(0)
  })

  test('a dev run starts the project dev server once confirmed, opens the debug app, and builds nothing', async () => {
    const { manager, runs, user, request, children, checkout, commands, spawned, signals, waitStage } = setup(true)
    await manager.list()
    const dev = { ...request, mode: 'dev' as const, deviceId: 'SIM-1' }
    const asked = await runs.start(dev, user).catch((cause: unknown) => cause)
    expect((asked as DeviceDomainError).code).toBe('confirmation_required')
    expect(spawned).toHaveLength(0)
    const run = await runs.start({ ...dev, approve: true }, user)
    while (spawned.length === 0) await new Promise((resolveTick) => setImmediate(resolveTick))
    expect(spawned).toEqual([{ command: 'npx', args: ['expo', 'start', '--localhost', '--port', '8081'], cwd: checkout }])
    children[0]!.stdout.emit('data', Buffer.from('Waiting on http://localhost:8081\n'))
    await waitStage('running')
    expect(commands).toContain('xcrun simctl get_app_container SIM-1 dev.solus.demo')
    expect(commands).toContain('xcrun simctl launch SIM-1 dev.solus.demo')
    expect(spawned).toHaveLength(1)
    runs.cancel(run.runId)
    expect(signals).toEqual([[4242, 'SIGTERM']])
    children[0]!.exit(143)
    expect(runs.list()[0]!.stage).toBe('cancelled')
  })

  test('one dev server opens the app on more simulators without starting another', async () => {
    const { manager, runs, user, request, children, commands, spawned, waitStage } = setup(true)
    await manager.list()
    const first = await runs.start({ ...request, mode: 'dev', deviceId: 'SIM-1', approve: true }, user)
    while (children.length === 0) await new Promise((resolveTick) => setImmediate(resolveTick))
    // Before Metro is ready, a second simulator waits rather than starting a second server.
    await expect(runs.start({ ...request, mode: 'dev', deviceId: 'SIM-2' }, user)).rejects.toThrow('still starting')
    children[0]!.stdout.emit('data', Buffer.from('Waiting on http://localhost:8081\n'))
    await waitStage('running')
    const second = await runs.start({ ...request, mode: 'dev', deviceId: 'SIM-2' }, user)
    expect(second.runId).toBe(first.runId)
    expect(spawned).toHaveLength(1)
    expect(commands).toContain('xcrun simctl launch SIM-1 dev.solus.demo')
    expect(commands).toContain('xcrun simctl launch SIM-2 dev.solus.demo')
    expect(runs.list()[0]!.stage).toBe('running')
  })

  test("a dev run joins this project's running dev server and starts nothing", async () => {
    // Metro reports the folder it serves, which is the selected project.
    const { manager, runs, user, request, commands, spawned, waitStage } = setup(true, { devServer: (checkout) => ({ state: 'running', projectRoot: checkout }) })
    await manager.list()
    await runs.start({ ...request, mode: 'dev', deviceId: 'SIM-1' }, user)
    await waitStage('done')
    expect(spawned).toHaveLength(0)
    expect(commands).toContain('xcrun simctl launch SIM-1 dev.solus.demo')
    expect(runs.list()[0]).toMatchObject({ mode: 'dev', stage: 'done', error: null })
  })

  test("another project's dev server is never adopted", async () => {
    const { manager, runs, user, request, spawned } = setup(true, { devServer: () => ({ state: 'running', projectRoot: '/elsewhere/app' }) })
    await manager.list()
    const error = await runs.start({ ...request, mode: 'dev', deviceId: 'SIM-1', approve: true }, user).catch((cause: unknown) => cause)
    expect((error as DeviceDomainError).detail).toContain('serves /elsewhere/app')
    expect(spawned).toHaveLength(0)
  })

  test('a dev run needs the debug app already on the simulator', async () => {
    const { manager, runs, user, request, children, commands, signals, waitStage } = setup(true, { appInstalled: false })
    await manager.list()
    await runs.start({ ...request, mode: 'dev', deviceId: 'SIM-1', approve: true }, user)
    while (children.length === 0) await new Promise((resolveTick) => setImmediate(resolveTick))
    children[0]!.stdout.emit('data', Buffer.from('Waiting on http://localhost:8081\n'))
    await waitStage('failed')
    expect(runs.list()[0]!.error).toContain('dev.solus.demo is not on iPhone 17')
    expect(commands.some((command) => command.includes('simctl launch'))).toBe(false)
    // The server Solus started for this run stops with it.
    expect(signals).toEqual([[4242, 'SIGTERM']])
  })

  test('a dev run never targets a phone', async () => {
    const { manager, runs, user, request, spawned } = setup(true)
    await manager.list()
    const error = await runs.start({ ...request, mode: 'dev', deviceId: 'PHONE-1', approve: true }, user).catch((cause: unknown) => cause)
    expect((error as DeviceDomainError).code).toBe('action_unsupported')
    expect(spawned).toHaveLength(0)
  })

  test('in a monorepo whose root also lists Expo, the native project is generated in the app that owns the build folder', async () => {
    const { manager, runs, user, request, checkout, children, spawned } = setup(true)
    const app = join(checkout, 'apps', 'mobile')
    mkdirSync(join(app, 'node_modules'), { recursive: true })
    writeFileSync(join(app, 'package.json'), JSON.stringify({ dependencies: { expo: '1' } }))
    writeFileSync(join(checkout, '.solus', 'config.json'), JSON.stringify({ version: 1, deviceRuns: [{ ...profile, cwd: 'apps/mobile/ios' }] }))
    await manager.list()
    await runs.start({ ...request, approve: true }, user)
    while (spawned.length === 0) await new Promise((resolveTick) => setImmediate(resolveTick))
    expect(spawned[0]).toEqual({ command: 'npx', args: ['expo', 'prebuild', '--platform', 'ios', '--no-install'], cwd: app })
    children[0]!.exit(1)
  })

  test('an Android build is an APK to download as well as to install', async () => {
    const { manager, runs, user, request, checkout, children, commands, waitStage } = setup()
    mkdirSync(join(checkout, 'android'), { recursive: true })
    writeFileSync(join(checkout, '.solus', 'config.json'), JSON.stringify({ version: 1, deviceRuns: [{
      name: 'Android', platform: 'android', target: 'any', cwd: 'android',
      command: ['./gradlew', 'assembleDebug'], artifact: 'app/build/outputs/apk/debug/*.apk',
    }] }))
    const started = await runs.start({ ...request, target: 'android', profileName: 'Android', approve: true }, user)
    await waitStage('building')
    mkdirSync(join(checkout, 'android', 'app/build/outputs/apk/release'), { recursive: true })
    writeFileSync(join(checkout, 'android', 'app/build/outputs/apk/release/app-release.apk'), 'app')
    children[0]!.exit(0)
    await waitStage('done')
    expect(runs.list()[0]).toMatchObject({ target: 'android', deviceName: null, stage: 'done' })
    expect(runs.list()[0]!.buildId).not.toBeNull()
    expect(manager.state().builds[0]!.assetId).not.toBeNull()
    expect(commands.some((command) => command.includes(' install '))).toBe(false)
    expect(started.mode).toBe('device')
  })

  test('a failed build says so and installs nothing', async () => {
    const { manager, runs, user, request, children, commands, waitStage } = setup()
    await manager.list()
    await runs.start({ ...request, approve: true }, user)
    await waitStage('building')
    children[0]!.stderr.emit('data', Buffer.from('error: no such scheme\n'))
    children[0]!.exit(65)
    await waitStage('failed')
    expect(runs.list()[0]).toMatchObject({ stage: 'failed', error: 'The build failed (exit 65). Open the log to see why.' })
    expect(commands.some((command) => command.includes('install app'))).toBe(false)
  })

  test('cancel signals only the build the host started, and a second click watches the same build', async () => {
    const { manager, runs, user, request, children, signals, spawned, waitStage } = setup()
    await manager.list()
    const first = await runs.start({ ...request, approve: true }, user)
    const second = await runs.start(request, user)
    await waitStage('building')
    expect(second.runId).toBe(first.runId)
    expect(spawned).toHaveLength(1)
    runs.cancel(first.runId)
    expect(signals).toEqual([[4242, 'SIGTERM']])
    children[0]!.exit(143)
    await waitStage('cancelled')
    expect(runs.list()[0]!.stage).toBe('cancelled')
  })

  test('a host restart retains output and logs but reports that its dev server stopped', async () => {
    const { root, checkout, manager } = setup()
    const saved: DeviceRun = {
      runId: 'saved-run', profileName: 'iOS device', checkout: 'checkout', checkoutPath: checkout, projectPath: checkout, target: null,
      source: 'main', mode: 'dev', commit: 'a'.repeat(40), outputCommit: 'a'.repeat(40),
      branch: 'main', deviceHostId: 'local', deviceId: 'PHONE-1', deviceName: 'Ash iPhone',
      stage: 'running', lastLine: 'Ready', error: null, buildId: 'useful-output', startedAt: 1, endedAt: null,
    }
    await new DeviceRunState(join(root, 'run-app.json')).save([{ run: saved, log: 'Ready\n', truncated: false }])
    const restarted = new DeviceRuns({ manager, approvalsPath: join(root, 'approvals.json'), changed: () => {}, spawn: () => { throw new Error('Restart must not launch a process') } })
    expect(restarted.list()[0]).toMatchObject({ stage: 'failed', buildId: 'useful-output', error: 'The host restarted. Run the app again.' })
    expect(restarted.log('saved-run').text).toBe('Ready\n')
  })

  test('a build folder outside the checkout is refused', async () => {
    const { manager, runs, user, request, checkout } = setup()
    writeFileSync(join(checkout, '.solus', 'config.json'), JSON.stringify({ version: 1, deviceRuns: [{ ...profile, cwd: '../elsewhere' }] }))
    await manager.list()
    const error = await runs.start({ ...request, approve: true }, user).catch((cause: unknown) => cause)
    expect((error as DeviceDomainError).detail).toContain('outside the project')
  })
})

test('the output pattern finds the newest match', async () => {
  const base = mkdtempSync(join(tmpdir(), 'solus-artifact-'))
  mkdirSync(join(base, 'out', 'Old.app'), { recursive: true })
  mkdirSync(join(base, 'out', 'New.app'), { recursive: true })
  utimesSync(join(base, 'out', 'Old.app'), 1, 1)
  expect(await findArtifact(base, 'out/*.app')).toBe(join(base, 'out', 'New.app'))
  expect(await findArtifact(base, 'out/*.apk')).toBeNull()
})
