import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * The native fingerprint must see the Expo native modules before anything
 * relies on it. `@expo/fingerprint` 0.21.x hashes each autolinked Gradle
 * plugin's `sourceDir`. expo-widgets declares a plugin from Maven with no
 * `sourceDir`, so the Android sourcer throws, and its catch returns no Expo
 * module sources at all: a native change then keeps the same Android hash
 * (T3 Code #20384, expo/expo#51710). Solus publishes no OTA update and has no
 * build cache, so nothing reads the hash today. This guard fails when such a
 * consumer is added while the Android fingerprint is still blind.
 */

const root = resolve(import.meta.dir, '../..')
const mobile = join(root, 'apps/mobile')

type ConfigSetting = string | { policy?: string; plugin?: string } | null
/** The resolved Expo config settings that make Expo read a native fingerprint. */
type FingerprintSettings = {
  runtimeVersion: ConfigSetting
  iosRuntimeVersion: ConfigSetting
  androidRuntimeVersion: ConfigSetting
  buildCacheProvider: ConfigSetting
  experimentsBuildCacheProvider: ConfigSetting
}
type FingerprintReading = { android: number; ios: number; settings: FingerprintSettings }

/**
 * The fingerprint consumers this guard can see: the resolved Expo config
 * (`app.json` or a dynamic `app.config.*`), the `expo-updates` dependency,
 * `eas.json`, and the repository workflows. Each setting is reported on its
 * own, so one configured `runtimeVersion` does not hide another.
 */
function fingerprintConsumers(settings: FingerprintSettings): string[] {
  const manifest: { dependencies?: { 'expo-updates'?: string } } = JSON.parse(readFileSync(join(mobile, 'package.json'), 'utf8'))
  const consumers = Object.entries(settings).filter(([, value]) => value != null).map(([name]) => `expo config: ${name}`)
  if (manifest.dependencies?.['expo-updates']) consumers.push('apps/mobile/package.json: expo-updates')
  if (existsSync(join(mobile, 'eas.json'))) consumers.push('apps/mobile/eas.json')
  const workflows = join(root, '.github/workflows')
  for (const file of existsSync(workflows) ? readdirSync(workflows) : []) {
    if (/\beas\s+(build|update)\b|fingerprint/i.test(readFileSync(join(workflows, file), 'utf8'))) consumers.push(`.github/workflows/${file}`)
  }
  return consumers
}

/**
 * The Expo native module sources each platform's fingerprint hashes, and the
 * resolved config settings. Node computes them, as the Expo CLI does: under
 * Bun, the fingerprint's Node IPC config loader fails and the sources come
 * back empty. The reading returns through a file because Bun's
 * `execFileSync` drops this child's stdout. The timeout stops a stalled
 * config loader from holding the unit runner.
 */
function readFingerprint(): FingerprintReading {
  const script = `
    const projectRoot = process.argv[1]
    const { createFingerprintAsync } = require(require.resolve('@expo/fingerprint', { paths: [projectRoot] }))
    const { getConfig } = require(require.resolve('@expo/config', { paths: [projectRoot] }))
    const { exp } = getConfig(projectRoot, { skipSDKVersionRequirement: true, skipPlugins: true })
    const settings = {
      runtimeVersion: exp.runtimeVersion ?? null,
      iosRuntimeVersion: exp.ios?.runtimeVersion ?? null,
      androidRuntimeVersion: exp.android?.runtimeVersion ?? null,
      buildCacheProvider: exp.buildCacheProvider ?? null,
      experimentsBuildCacheProvider: exp.experiments?.buildCacheProvider ?? null,
    }
    const count = async (platform, reason) => (await createFingerprintAsync(projectRoot, { platforms: [platform] }))
      .sources.filter((source) => (source.reasons ?? []).includes(reason)).length
    Promise.all([count('android', 'expoAutolinkingAndroid'), count('ios', 'expoAutolinkingIos')])
      .then(([android, ios]) => require('node:fs').writeFileSync(process.argv[2], JSON.stringify({ android, ios, settings })))
  `
  const directory = mkdtempSync(join(tmpdir(), 'solus-fingerprint-'))
  try {
    const result = join(directory, 'reading.json')
    execFileSync('node', ['-e', script, mobile, result], { timeout: 30_000 })
    return JSON.parse(readFileSync(result, 'utf8'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('native fingerprint', () => {
  test('nothing relies on an Android fingerprint that misses the Expo native modules', () => {
    const reading = readFingerprint()
    // iOS has no Maven plugin, so its count proves the reading itself works.
    expect(reading.ios).toBeGreaterThan(0)
    expect(reading.android === 0 ? fingerprintConsumers(reading.settings) : []).toEqual([])
  }, 60_000)
})
