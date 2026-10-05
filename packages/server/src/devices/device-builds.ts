import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { DEVICE_PLATFORMS, type DeviceBuild, type DeviceSummary } from '@solus/contracts/device-types'
import { storedAssetPath } from '../data/assets/asset-paths'
import { writeAssetFile } from '../data/assets/assets'
import { createLogger } from '../logger'
import { DeviceDomainError } from './device-errors'
import { boundedDetail, type DeviceCommandRunner } from './device-process'

const log = createLogger('devices', 'device-builds.ts')

/**
 * App builds an agent hands to Solus, and how one goes onto a device
 * (plan 016, a first part of S02). Building stays with the agent; Solus
 * records the output, installs it and opens it. Signing is the project's own:
 * a device build must already be signed for development.
 */

const MAX_BUILDS = 20
const INSTALL_TIMEOUT_MS = 5 * 60_000
const LAUNCH_TIMEOUT_MS = 60_000
const APP_ID = /^[A-Za-z0-9._-]{1,255}$/

/** A build plus where its bytes are on this host. The path never leaves the host. */
export interface StoredDeviceBuild extends DeviceBuild {
  path: string
}

const storedBuildSchema = z.object({
  buildId: z.string().min(1),
  platform: z.enum(DEVICE_PLATFORMS),
  runsOn: z.enum(['simulator', 'device', 'any']),
  appId: z.string().nullable(),
  name: z.string(),
  sessionId: z.string(),
  sizeBytes: z.number(),
  createdAt: z.number(),
  assetId: z.string().nullable(),
  lastInstall: z.object({ deviceHostId: z.string(), deviceId: z.string(), deviceName: z.string(), installedAt: z.number() }).nullable(),
  path: z.string().min(1),
})

export interface DeviceBuildStoreDeps {
  /** builds.json under the device root. */
  path: string
  run: DeviceCommandRunner
  assetsDir?: string
  now?: () => number
}

export class DeviceBuildStore {
  private builds: StoredDeviceBuild[]
  private readonly now: () => number

  constructor(private readonly deps: DeviceBuildStoreDeps) {
    this.now = deps.now ?? Date.now
    this.builds = this.load()
  }

  /** Newest first, without host paths. */
  list(): DeviceBuild[] {
    return this.builds.map(({ path: _path, ...build }) => ({ ...build, lastInstall: build.lastInstall ? { ...build.lastInstall } : null }))
  }

  get(buildId: string): StoredDeviceBuild {
    const build = this.builds.find((candidate) => candidate.buildId === buildId)
    if (!build) throw new DeviceDomainError('invalid_request', 'That build is no longer on this host. Ask the agent to build it again.')
    return build
  }

  /** Record a build output: an iOS `.app` bundle or an Android `.apk`. */
  async add(path: string, sessionId: string, appIdHint?: string): Promise<StoredDeviceBuild> {
    const info = await stat(path).catch(() => null)
    if (!info) throw new DeviceDomainError('invalid_request', `No build output at ${basename(path)}.`)
    if (appIdHint !== undefined && !APP_ID.test(appIdHint)) throw new DeviceDomainError('invalid_request', 'The app id is not a valid bundle id or package name.')
    let build: StoredDeviceBuild
    if (info.isDirectory() && path.endsWith('.app')) {
      const plist = join(path, 'Info.plist')
      const [appId, platforms] = await Promise.all([
        this.deps.run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist], { timeoutMs: 10_000 }),
        this.deps.run('plutil', ['-extract', 'CFBundleSupportedPlatforms', 'json', '-o', '-', plist], { timeoutMs: 10_000 }),
      ])
      const readAppId = appId.code === 0 ? appId.stdout.trim() : ''
      build = this.record({
        platform: 'ios',
        runsOn: platforms.stdout.includes('iPhoneSimulator') ? 'simulator' : platforms.stdout.includes('iPhoneOS') ? 'device' : 'any',
        appId: APP_ID.test(readAppId) ? readAppId : appIdHint ?? null,
        name: basename(path),
        sessionId,
        sizeBytes: await directorySize(path),
        assetId: null,
        path,
      })
    } else if (info.isFile() && path.endsWith('.apk')) {
      const stored = await writeAssetFile(path, 'apk', this.deps.assetsDir === undefined ? {} : { assetsDir: this.deps.assetsDir })
      build = this.record({
        platform: 'android',
        runsOn: 'any',
        appId: appIdHint ?? null,
        name: basename(path),
        sessionId,
        sizeBytes: stored.size,
        assetId: stored.id,
        path: storedAssetPath(stored.id, this.deps.assetsDir),
      })
    } else {
      throw new DeviceDomainError('invalid_request', 'Pass the build output: an iOS .app bundle or an Android .apk file.')
    }
    // The same output built again replaces its older entry.
    const replaced = this.builds.filter((candidate) => candidate.path === build.path)
    this.builds = [build, ...this.builds.filter((candidate) => candidate.path !== build.path)]
    const evicted = this.builds.splice(MAX_BUILDS)
    await this.save()
    for (const old of evicted) {
      if (old.assetId && !this.builds.some((candidate) => candidate.assetId === old.assetId)) await unlink(old.path).catch(() => {})
    }
    log.info('device_build_added', { sessionId, buildId: build.buildId, platform: build.platform, runsOn: build.runsOn, replaced: replaced.length })
    return build
  }

  async noteInstall(buildId: string, device: DeviceSummary): Promise<DeviceBuild> {
    const build = this.get(buildId)
    build.lastInstall = { deviceHostId: device.deviceHostId, deviceId: device.deviceId, deviceName: device.name, installedAt: this.now() }
    await this.save()
    return this.list().find((candidate) => candidate.buildId === buildId)!
  }

  private record(fields: Omit<StoredDeviceBuild, 'buildId' | 'createdAt' | 'lastInstall'>): StoredDeviceBuild {
    return { buildId: `build_${randomUUID()}`, createdAt: this.now(), lastInstall: null, ...fields }
  }

  private load(): StoredDeviceBuild[] {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.deps.path, 'utf8'))
      if (!Array.isArray(raw)) return []
      return raw.flatMap((entry) => {
        const parsed = storedBuildSchema.safeParse(entry)
        return parsed.success ? [parsed.data] : []
      }).slice(0, MAX_BUILDS)
    } catch {
      return []
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.deps.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.deps.path}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(this.builds, null, 2), { mode: 0o600 })
    await rename(temporary, this.deps.path)
  }
}

async function directorySize(path: string): Promise<number> {
  const entries = await readdir(path, { recursive: true, withFileTypes: true }).catch(() => [])
  let total = 0
  for (const entry of entries) {
    if (entry.isFile()) total += (await stat(join(entry.parentPath, entry.name)).catch(() => null))?.size ?? 0
  }
  return total
}

/** The commands that put a build on a device and open it, in order. */
export function installCommands(build: StoredDeviceBuild, device: DeviceSummary, launch: boolean): { install: [string, string[]]; launch: [string, string[]] | null } {
  const appId = launch ? build.appId : null
  if (device.platform === 'android') {
    return {
      install: ['adb', ['-s', device.deviceId, 'install', '-r', build.path]],
      launch: appId ? ['adb', ['-s', device.deviceId, 'shell', 'monkey', '-p', appId, '-c', 'android.intent.category.LAUNCHER', '1']] : null,
    }
  }
  if (device.physical) {
    return {
      install: ['xcrun', ['devicectl', 'device', 'install', 'app', '--device', device.deviceId, build.path]],
      launch: appId ? ['xcrun', ['devicectl', 'device', 'process', 'launch', '--device', device.deviceId, '--terminate-existing', appId]] : null,
    }
  }
  return {
    install: ['xcrun', ['simctl', 'install', device.deviceId, build.path]],
    launch: appId ? ['xcrun', ['simctl', 'launch', device.deviceId, appId]] : null,
  }
}

/** A failed install in words a person can act on. Unknown failures keep their first line. */
export function explainInstallFailure(output: string, device: DeviceSummary): string {
  const rules: [RegExp, string][] = [
    [/developer mode/i, `Turn on Developer Mode on ${device.name}: Settings → Privacy & Security → Developer Mode.`],
    [/locked|passcode/i, `Unlock ${device.name} and try again.`],
    [/not paired|pairing|trust/i, `${device.name} does not trust this Mac. Unlock it, tap Trust, and try again.`],
    [/provisioning profile|code ?sign|signature|0xe8008015|0xe800801c/i, `The build is not signed for ${device.name}. Build it with your development team and automatic signing (xcodebuild -allowProvisioningUpdates), and register the device in your team.`],
    [/untrusted developer|verify app/i, `Trust the developer on ${device.name}: Settings → General → VPN & Device Management.`],
    [/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i, `${device.name} has this app signed with a different key. Uninstall it from the device, then install again.`],
    [/INSTALL_FAILED_NO_MATCHING_ABIS/i, `The APK has no native code for ${device.name}'s processor. Build it for that architecture.`],
    [/INSTALL_FAILED_OLDER_SDK/i, `${device.name} runs an Android version older than the app's minimum.`],
    [/unauthorized/i, `${device.name} has not allowed USB debugging from this computer. Unlock it and accept the prompt.`],
    [/timed out/i, `The install on ${device.name} did not finish in time. Check the device and try again.`],
  ]
  for (const [pattern, explanation] of rules) if (pattern.test(output)) return explanation
  return `The install on ${device.name} failed: ${boundedDetail(output, 200) || 'no output'}`
}

/** Install a build and open it. Throws a domain error a person or agent can act on. */
export async function installBuild(run: DeviceCommandRunner, build: StoredDeviceBuild, device: DeviceSummary, launch: boolean): Promise<{ launched: boolean }> {
  if (!(await stat(build.path).catch(() => null))) {
    throw new DeviceDomainError('invalid_request', `The output of ${build.name} is no longer on this host. Build it again.`)
  }
  const commands = installCommands(build, device, launch)
  const installed = await run(commands.install[0], commands.install[1], { timeoutMs: INSTALL_TIMEOUT_MS })
  if (installed.code !== 0) throw new DeviceDomainError('command_failed', explainInstallFailure(`${installed.stderr}\n${installed.stdout}`, device))
  if (!commands.launch) return { launched: false }
  const launched = await run(commands.launch[0], commands.launch[1], { timeoutMs: LAUNCH_TIMEOUT_MS })
  if (launched.code !== 0) {
    throw new DeviceDomainError('command_failed', `${build.name} is installed on ${device.name}, but it did not open: ${explainInstallFailure(`${launched.stderr}\n${launched.stdout}`, device)}`)
  }
  return { launched: true }
}
