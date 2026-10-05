import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceProjectDetector, scanDeviceProject } from '@solus/server/devices/device-project'

/**
 * Device entry points show only for projects that build a mobile app, at the
 * root or in a subfolder. A web project must not grow a Devices row because
 * a dependency happens to contain one.
 */

function project(files: { [path: string]: string }): string {
  const root = mkdtempSync(join(tmpdir(), 'solus-project-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    if (path.endsWith('/')) mkdirSync(join(root, path), { recursive: true })
    else writeFileSync(join(root, path), content)
  }
  return root
}

describe('mobile project detection', () => {
  test('an Expo app in a monorepo subfolder counts', async () => {
    const root = project({
      'package.json': JSON.stringify({ dependencies: { react: '19' } }),
      'apps/mobile/package.json': JSON.stringify({ dependencies: { expo: '~57.0.0', 'react-native': '0.86' } }),
    })
    const info = await scanDeviceProject(root)
    expect(info).toEqual({ isMobileApp: true, platforms: ['android', 'ios'], markers: ['apps/mobile/package.json'] })
  })

  test('native iOS and Android projects count by their own files', async () => {
    const ios = await scanDeviceProject(project({ 'ios/Demo.xcodeproj/': '' }))
    expect([ios.isMobileApp, ios.platforms]).toEqual([true, ['ios']])
    const android = await scanDeviceProject(project({ 'android/settings.gradle.kts': '', 'android/app/build.gradle.kts': '' }))
    expect([android.isMobileApp, android.platforms]).toEqual([true, ['android']])
    const flutter = await scanDeviceProject(project({ 'pubspec.yaml': 'name: demo\ndependencies:\n  flutter:\n    sdk: flutter\n' }))
    expect(flutter.isMobileApp).toBe(true)
  })

  test('a web project does not count, even with a mobile package inside node_modules', async () => {
    const root = project({
      'package.json': JSON.stringify({ dependencies: { svelte: '5' } }),
      'node_modules/react-native/package.json': JSON.stringify({ dependencies: { 'react-native': '1' } }),
      'node_modules/some-lib/ios/Lib.xcodeproj/': '',
      '.cache/Demo.xcodeproj/': '',
    })
    expect(await scanDeviceProject(root)).toEqual({ isMobileApp: false, platforms: [], markers: [] })
  })

  test('the scan stops at a fixed depth', async () => {
    // WHY: the panel asks on every view; a deep tree must cost bounded work.
    const root = project({ 'a/b/c/d/e/f/package.json': JSON.stringify({ dependencies: { expo: '1' } }) })
    expect((await scanDeviceProject(root)).isMobileApp).toBe(false)
  })

  test('one root is scanned once while its answer is fresh', async () => {
    let scans = 0
    let now = 0
    const detector = new DeviceProjectDetector(async () => { scans++; return { isMobileApp: true, platforms: ['ios'], markers: [] } }, () => now)
    await detector.detect('/p')
    await detector.detect('/p')
    expect(scans).toBe(1)
    now += 10 * 60_000
    await detector.detect('/p')
    expect(scans).toBe(2)
  })
})
