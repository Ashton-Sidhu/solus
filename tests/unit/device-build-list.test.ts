import { expect, test } from 'bun:test'
import type { DeviceBuild, DeviceRun } from '@solus/contracts/device-types'
import { finishedRuns } from '@solus/client-core/device-builds'
import { buildSourceLabel, buildTargetLabel, installSummary, runFinishedToast } from '@solus/workspace-ui/components/devices/lib/build-list'

/**
 * The builds list says what each build is and where it came from, and a
 * person always hears how a build or an install ended: a build that ends while
 * they look elsewhere still says so, and one failed device never hides the
 * devices that worked.
 */

const run: DeviceRun = {
  runId: 'r1', profileName: 'iOS', mode: 'device', target: 'ios-simulator', source: 'main', commit: 'b'.repeat(40), outputCommit: 'a'.repeat(40),
  checkout: 'app', checkoutPath: '/code/app', projectPath: '/code/app', branch: 'main',
  deviceHostId: null, deviceId: null, deviceName: null,
  stage: 'building', lastLine: null, error: null, buildId: 'b1', startedAt: 1, endedAt: null,
}
const build: Pick<DeviceBuild, 'buildId' | 'name' | 'platform' | 'runsOn'> = { buildId: 'b1', name: 'Demo.app', platform: 'ios', runsOn: 'simulator' }

test('a build names its target in the words of Build for, and the commit it was built from', () => {
  expect(buildTargetLabel(build)).toBe('iOS Simulator')
  expect(buildTargetLabel({ platform: 'ios', runsOn: 'device' })).toBe('iPhone or iPad')
  // A failed retry keeps the last useful output, so the output commit is the one built.
  expect(buildSourceLabel(build, [run])).toBe('main @ aaaaaaa')
  expect(buildSourceLabel({ buildId: 'agent' }, [run])).toBe('Agent build')
})

test('one toast sums up an install on several devices and names each failure', () => {
  expect(installSummary(build, [{ deviceName: 'iPhone 17', error: null }, { deviceName: 'iPad Air', error: null }]))
    .toMatchObject({ variant: 'success', message: 'Installed Demo.app', description: 'On 2 devices.' })
  expect(installSummary(build, [{ deviceName: 'iPhone 17', error: null }, { deviceName: 'iPad Air', error: 'Not running' }]))
    .toMatchObject({ variant: 'error', message: 'Installed Demo.app on 1 of 2 devices', description: 'iPad Air: Not running' })
  expect(installSummary(build, [{ deviceName: 'iPad Air', error: 'Not running' }]).message).toBe('Could not install Demo.app')
})

test('a build that ends is reported once, and a snapshot that only repeats it says nothing', () => {
  const done = { ...run, stage: 'done' as const }
  expect(finishedRuns([run], [done]).map((finished) => finished.runId)).toEqual(['r1'])
  expect(finishedRuns([done], [done])).toEqual([])
  expect(runFinishedToast(done)).toMatchObject({ variant: 'success', message: 'iOS Simulator build ready' })
  expect(runFinishedToast({ ...run, stage: 'failed', error: 'The build failed (exit 65).' })).toMatchObject({ variant: 'error', description: 'The build failed (exit 65).' })
  // A dev run that worked already opened the app in front of the person.
  expect(runFinishedToast({ ...run, mode: 'dev', target: null, stage: 'done' })).toBeNull()
})
