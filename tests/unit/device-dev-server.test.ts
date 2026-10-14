import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { devApp, servesCheckout } from '@solus/server/devices/device-dev-server'

/**
 * A dev run joins Metro only for the selected project, and opens the app
 * the project names: from Expo's manifest, or from the native projects.
 */

const manifest = (config: object) => (async () => Response.json({ extra: { expoClient: config } })) as unknown as typeof fetch

test('Metro serves a checkout when its root is the checkout or an app folder inside it', async () => {
  const checkout = mkdtempSync(join(tmpdir(), 'solus-dev-'))
  mkdirSync(join(checkout, 'apps', 'mobile'), { recursive: true })
  expect(await servesCheckout(checkout, checkout)).toBe(true)
  expect(await servesCheckout(join(checkout, 'apps', 'mobile'), checkout)).toBe(true)
  // A sibling with a shared prefix is another project.
  expect(await servesCheckout(`${checkout}-worktree`, checkout)).toBe(false)
})

test('an Expo app with a dev client opens through its exp+ scheme', async () => {
  const app = mkdtempSync(join(tmpdir(), 'solus-dev-'))
  writeFileSync(join(app, 'package.json'), JSON.stringify({ dependencies: { expo: '1', 'expo-dev-client': '1' } }))
  const fetcher = manifest({ slug: 'demo', ios: { bundleIdentifier: 'dev.solus.demo' }, android: { package: 'dev.solus.android' } })
  expect(await devApp(app, 'ios', true, fetcher)).toEqual({ appId: 'dev.solus.demo', devClientScheme: 'exp+demo' })
  expect(await devApp(app, 'android', true, fetcher)).toEqual({ appId: 'dev.solus.android', devClientScheme: 'exp+demo' })
})

test('a React Native app is named by its native projects', async () => {
  const app = mkdtempSync(join(tmpdir(), 'solus-dev-'))
  mkdirSync(join(app, 'android', 'app'), { recursive: true })
  mkdirSync(join(app, 'ios', 'Demo.xcodeproj'), { recursive: true })
  writeFileSync(join(app, 'android', 'app', 'build.gradle'), 'android {\n  defaultConfig {\n    applicationId "com.demo.app"\n  }\n}\n')
  writeFileSync(join(app, 'ios', 'Demo.xcodeproj', 'project.pbxproj'), 'PRODUCT_BUNDLE_IDENTIFIER = "$(PRODUCT_NAME)";\nPRODUCT_BUNDLE_IDENTIFIER = com.demo.ios;\n')
  expect(await devApp(app, 'android', false)).toEqual({ appId: 'com.demo.app', devClientScheme: null })
  expect(await devApp(app, 'ios', false)).toEqual({ appId: 'com.demo.ios', devClientScheme: null })
  await expect(devApp(mkdtempSync(join(tmpdir(), 'solus-dev-')), 'ios', false)).rejects.toThrow('bundle id')
})
