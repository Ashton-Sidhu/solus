import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeviceHostSummary, DeviceRunProfile } from '@solus/contracts/device-types'
import { DeviceBuildStore } from '@solus/server/devices/device-builds'
import { DeviceDomainError } from '@solus/server/devices/device-errors'
import type { DeviceHost, DeviceHostReady } from '@solus/server/devices/device-host'
import { DeviceHubClient } from '@solus/server/devices/device-hub-client'
import { DeviceManager } from '@solus/server/devices/device-manager'
import type { DeviceCommandRunner } from '@solus/server/devices/device-process'
import { DeviceRuns, findArtifact, type BuildSpawner } from '@solus/server/devices/device-run'
import { DeviceSettingsStore } from '@solus/server/devices/device-settings-store'

/**
 * Build and run (plan 016, S02). The rules: a command from the repository
 * runs only after a person confirmed it once on this host; the app built is
 * the one installed; a failed build says so; Cancel signals only the process
 * the host started.
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

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'solus-run-'))
  const checkout = join(root, 'checkout')
  mkdirSync(join(checkout, '.solus'), { recursive: true })
  mkdirSync(join(checkout, 'ios'), { recursive: true })
  writeFileSync(join(checkout, '.solus', 'config.json'), JSON.stringify({ version: 1, deviceRuns: [profile] }))
  const commands: string[] = []
  const run: DeviceCommandRunner = async (command, args) => {
    commands.push([command, ...args].join(' '))
    if (command === 'sh') return { code: 0, stdout: devicectlJson, stderr: '' }
    if (command === 'plutil') return { code: 0, stdout: args.includes('CFBundleIdentifier') ? 'dev.solus.demo' : '["iPhoneOS"]', stderr: '' }
    if (command === 'git') return { code: 1, stdout: '', stderr: 'not a repository' }
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
    hub: new DeviceHubClient((async () => Response.json({ simulators: [], emulators: [], errors: [] })) as unknown as typeof fetch),
    publish: () => {}, surfaceRequested: () => {}, storeImage: async () => ({ assetId: 'x.png' }),
    builds: new DeviceBuildStore({ path: join(root, 'builds.json'), run }),
  })
  const children: FakeChild[] = []
  const spawned: { command: string; args: string[]; cwd: string }[] = []
  const spawn: BuildSpawner = (command, args, options) => {
    spawned.push({ command, args, cwd: options.cwd })
    const child = new FakeChild()
    children.push(child)
    // SAFETY: the runner uses only the ChildProcess members FakeChild provides.
    return child as unknown as ChildProcess
  }
  const signals: [number, string][] = []
  const runs = new DeviceRuns({ manager, approvalsPath: join(root, 'approvals.json'), changed: () => {}, spawn, run, killGroup: (pid, signal) => { signals.push([pid, signal]) } })
  const user = { kind: 'user' as const, clientId: 'c1', label: 'Ash' }
  const request = { checkoutPath: checkout, profileName: 'iOS device', deviceHostId: 'local', deviceId: 'PHONE-1' }
  return { root, checkout, manager, runs, user, request, children, spawned, signals, commands }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('build and run', () => {
  test('a command from the repository runs only after a person confirms it once', async () => {
    const { manager, runs, user, request, spawned, root, checkout } = setup()
    await manager.list()
    const first = await runs.start(request, user).catch((cause: unknown) => cause)
    expect((first as DeviceDomainError).code).toBe('confirmation_required')
    expect((first as DeviceDomainError).detail).toContain('xcodebuild -scheme App build')
    expect(spawned).toHaveLength(0)
    await runs.start({ ...request, approve: true }, user)
    expect(spawned).toEqual([{ command: 'xcodebuild', args: ['-scheme', 'App', 'build'], cwd: join(checkout, 'ios') }])
    // Remembered on this host: a new runner reads the same approvals.
    const again = new DeviceRuns({ manager, approvalsPath: join(root, 'approvals.json'), changed: () => {}, spawn: () => { throw new Error('spawned') }, run: async () => ({ code: 1, stdout: '', stderr: '' }), killGroup: () => {} })
    const second = await again.start(request, user).catch((cause: unknown) => cause)
    expect((second as DeviceDomainError | undefined)?.code).not.toBe('confirmation_required')
  })

  test('a finished build is recorded, installed on the device, and opened', async () => {
    const { manager, runs, user, request, children, checkout, commands } = setup()
    await manager.list()
    const run = await runs.start({ ...request, approve: true }, user)
    const app = join(checkout, 'ios', 'build', 'Debug-iphoneos', 'Demo.app')
    mkdirSync(app, { recursive: true })
    children[0]!.stdout.emit('data', Buffer.from('Compiling…\n** BUILD SUCCEEDED **\n'))
    children[0]!.exit(0)
    await settle()
    const done = runs.list()[0]!
    expect([done.stage, done.error]).toEqual(['done', null])
    expect(done.lastLine).toBe('** BUILD SUCCEEDED **')
    expect(manager.state().builds[0]!.buildId).toBe(done.buildId!)
    expect(commands.some((command) => command.startsWith('xcrun devicectl device install app --device PHONE-1') && command.endsWith(app))).toBe(true)
    expect(runs.log(run.runId).text).toContain('BUILD SUCCEEDED')
    // The person's borrowed control is given back.
    expect(manager.control.state({ deviceHostId: 'local', deviceId: 'PHONE-1' }).lease).toBeNull()
  })

  test('a failed build says so and installs nothing', async () => {
    const { manager, runs, user, request, children, commands } = setup()
    await manager.list()
    await runs.start({ ...request, approve: true }, user)
    children[0]!.stderr.emit('data', Buffer.from('error: no such scheme\n'))
    children[0]!.exit(65)
    await settle()
    expect(runs.list()[0]).toMatchObject({ stage: 'failed', error: 'The build failed (exit 65). Open the log to see why.' })
    expect(commands.some((command) => command.includes('install app'))).toBe(false)
  })

  test('cancel signals only the build the host started, and a second click watches the same build', async () => {
    const { manager, runs, user, request, children, signals, spawned } = setup()
    await manager.list()
    const first = await runs.start({ ...request, approve: true }, user)
    const second = await runs.start(request, user)
    expect(second.runId).toBe(first.runId)
    expect(spawned).toHaveLength(1)
    runs.cancel(first.runId)
    expect(signals).toEqual([[4242, 'SIGTERM']])
    children[0]!.exit(143)
    await settle()
    expect(runs.list()[0]!.stage).toBe('cancelled')
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
