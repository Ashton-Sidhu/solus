import { afterAll, expect, test } from 'bun:test'
import type { DeviceRun } from '@solus/contracts/device-types'
// The Run app is read without a mounted Svelte renderer.
const stateDescriptor = Object.getOwnPropertyDescriptor(globalThis, '$state')
Object.defineProperty(globalThis, '$state', { configurable: true, value: <T>(value: T) => value })
const { RunApp, runApps, hasActiveRun } = await import('@solus/workspace-ui/components/devices/lib/run-app.svelte')
afterAll(() => {
  if (stateDescriptor) Object.defineProperty(globalThis, '$state', stateDescriptor)
  else Reflect.deleteProperty(globalThis, '$state')
})

/**
 * Builds and dev servers belong to the host. Every conversation and window
 * therefore shows one Run app per host, and a run that is still going wins
 * over the choices, whatever its project, so a person who comes back finds it.
 */

const build: DeviceRun = {
  runId: 'r1', profileName: 'Android', mode: 'device', target: 'android', source: 'main', commit: 'a'.repeat(40),
  checkout: 'app', checkoutPath: '/code/app', projectPath: '/code/app', branch: 'release',
  deviceHostId: null, deviceId: null, deviceName: null,
  stage: 'building', lastLine: null, error: null, buildId: null, startedAt: 1, endedAt: null,
}
const defaultBranch = () => 'main'

test('every conversation and window on a host shares one Run app', () => {
  const runApp = runApps.for('host-a')
  runApp.chooseProject('/code/app')
  expect(runApps.for('host-a')).toBe(runApp)
  expect(runApps.for('host-b')).not.toBe(runApp)
})

test("a running build is shown from any conversation, even one in another project", () => {
  const view = new RunApp().view([build], '/code/other', defaultBranch)
  expect(view).toMatchObject({ projectPath: '/code/app', branch: 'release', target: 'android' })
  expect(view.latest?.runId).toBe('r1')
  expect(hasActiveRun([build])).toBe(true)
})

test('once the build ends, the choices apply again and find its finished run', () => {
  const done = { ...build, stage: 'done' as const, buildId: 'b1' }
  const runApp = new RunApp()
  expect(runApp.view([done], '/code/other', defaultBranch)).toMatchObject({ projectPath: '/code/other' })
  runApp.target = 'android'
  runApp.chooseProject('/code/app')
  runApp.branch = 'release'
  expect(runApp.view([done], '/code/other', defaultBranch).latest?.buildId).toBe('b1')
  expect(hasActiveRun([done])).toBe(false)
})

test('a new project starts on its default branch', () => {
  const runApp = new RunApp()
  runApp.branch = 'feature/old'
  runApp.chooseProject('/code/app')
  expect(runApp.view([], null, defaultBranch).branch).toBe('main')
})

test('one install reaches every checked device, and each device reports on its own', async () => {
  const runApp = new RunApp()
  const apk = { buildId: 'b1', platform: 'android', runsOn: 'any', appId: 'dev.demo', name: 'app.apk', sessionId: 's', sizeBytes: 1, createdAt: 0, assetId: 'a', lastInstall: null } as const
  const pixel = { deviceHostId: 'local', deviceId: 'emulator-5554', platform: 'android', name: 'Pixel 9', version: 'Android 15', booted: true, physical: false } as const
  const phone = { ...pixel, deviceId: 'R5CT', name: 'Galaxy', physical: true }
  const results = await runApp.install(apk, [pixel, phone], async (device) => {
    expect(runApp.installStatus('b1', device.deviceId)).toEqual({ state: 'installing' })
    if (device.physical) throw new Error('unauthorized')
  }, (cause) => (cause as Error).message)
  expect(results).toEqual([{ deviceName: 'Pixel 9', error: null }, { deviceName: 'Galaxy', error: 'unauthorized' }])
  expect(runApp.installStatus('b1', 'emulator-5554')).toEqual({ state: 'installed' })
  expect(runApp.installStatus('b1', 'R5CT')).toEqual({ state: 'failed', error: 'unauthorized' })
})

test('a finished dev run cannot replace the production build log', () => {
  const runApp = new RunApp()
  runApp.target = 'android'
  runApp.branch = 'release'
  const done = { ...build, stage: 'done' as const, buildId: 'b1' }
  const dev = { ...done, runId: 'dev', mode: 'dev' as const, target: null }
  expect(runApp.view([dev, done], '/code/app', defaultBranch).latest).toBe(done)
  expect(runApp.view([dev], '/code/app', defaultBranch).latest).toBeUndefined()
})

test('an existing dev run remains reachable for cancellation without a dev mode choice', () => {
  const dev = { ...build, mode: 'dev' as const, target: null, stage: 'running' as const }
  const view = new RunApp().view([dev], '/code/other', defaultBranch)
  expect(view.latest).toBe(dev)
  expect(view.target).toBe('ios-simulator')
  expect(hasActiveRun([dev])).toBe(true)
})
