import { existsSync, realpathSync } from 'node:fs'
import { z } from 'zod'
import { delimiter, dirname, join } from 'node:path'
import type { DevicePlatform, DevicePlatformAvailability } from '@solus/contracts/device-types'
import type { DeviceCommandRunner } from './device-process'

/**
 * Read-only toolchain checks. Nothing here installs, boots or starts a process
 * beyond short inspection commands.
 */

export interface ProbeDeps {
  env: NodeJS.ProcessEnv
  hostPlatform: NodeJS.Platform
  run: DeviceCommandRunner
  exists?: (path: string) => boolean
  realpath?: (path: string) => string
}

export interface AndroidSdk {
  root: string | null
  adb: boolean
  emulator: boolean
  avdmanager: boolean
  legacyAvdmanager: boolean
}

export function findAndroidSdk(deps: Pick<ProbeDeps, 'env' | 'hostPlatform' | 'exists' | 'realpath'>): AndroidSdk {
  const exists = deps.exists ?? existsSync
  const realpath = deps.realpath ?? realpathSync
  const { env } = deps
  const exe = (name: string) => (deps.hostPlatform === 'win32' ? `${name}.exe` : name)
  const home = env.HOME ?? env.USERPROFILE ?? ''
  const explicit = env.ANDROID_HOME?.trim() || env.ANDROID_SDK_ROOT?.trim()
  const candidates = explicit
    ? [explicit]
    : [join(home, 'Library', 'Android', 'sdk'), join(home, 'Android', 'Sdk')]
  if (!explicit) {
    for (const dir of (env.PATH ?? '').split(delimiter)) {
      if (!dir) continue
      try {
        candidates.push(dirname(dirname(realpath(join(dir, exe('adb'))))))
      } catch {
        // Not on this PATH entry.
      }
    }
  }
  for (const root of candidates) {
    const adb = exists(join(root, 'platform-tools', exe('adb')))
    const emulator = exists(join(root, 'emulator', exe('emulator')))
    if (explicit || adb || emulator) {
      const avdmanager = exists(join(root, 'cmdline-tools', 'latest', 'bin', 'avdmanager'))
      const legacyAvdmanager = !avdmanager && exists(join(root, 'tools', 'bin', 'avdmanager'))
      return { root, adb, emulator, avdmanager, legacyAvdmanager }
    }
  }
  return { root: null, adb: false, emulator: false, avdmanager: false, legacyAvdmanager: false }
}

/** The environment helpers run with: the SDK's tools first on PATH. */
export function deviceHostEnvironment(env: NodeJS.ProcessEnv, sdkRoot: string | null): NodeJS.ProcessEnv {
  if (!sdkRoot) return env
  return {
    ...env,
    ANDROID_HOME: sdkRoot,
    PATH: [join(sdkRoot, 'platform-tools'), join(sdkRoot, 'emulator'), env.PATH ?? ''].join(delimiter),
  }
}

/** `simctl list runtimes --json`: only availability and platform are read. */
const simctlRuntimesSchema = z.object({
  runtimes: z.array(z.object({
    platform: z.string().optional().catch(undefined),
    isAvailable: z.boolean().optional().catch(undefined),
  })),
})

/**
 * Why iOS is unavailable, or null. Probes Xcode itself rather than reading a
 * missing `simctl` as missing Xcode: Command Line Tools selected while a full
 * Xcode is installed is a different fix (`xcode-select -s`).
 */
export async function iosUnavailableReason(deps: ProbeDeps): Promise<string | null> {
  if (deps.hostPlatform !== 'darwin') return 'iOS Simulators need macOS with Xcode.'
  const exists = deps.exists ?? existsSync
  const selected = await deps.run('xcode-select', ['-p'], { timeoutMs: 5_000, env: deps.env })
  const developerDir = selected.stdout.trim()
  if (selected.code !== 0 || !developerDir) {
    return exists('/Applications/Xcode.app')
      ? 'Xcode is installed but not selected. Run `sudo xcode-select -s /Applications/Xcode.app` on this host.'
      : 'Xcode was not found. Install Xcode from the App Store on this host.'
  }
  if (developerDir.includes('CommandLineTools')) {
    return exists('/Applications/Xcode.app')
      ? 'Command Line Tools are selected instead of Xcode. Run `sudo xcode-select -s /Applications/Xcode.app` on this host.'
      : 'Only Command Line Tools are installed. iOS Simulators need the full Xcode app.'
  }
  const runtimes = await deps.run('xcrun', ['simctl', 'list', 'runtimes', '--json'], { timeoutMs: 15_000, env: deps.env })
  if (runtimes.code !== 0) return 'Xcode simulator tools did not respond. Open Xcode once to finish its setup.'
  try {
    const parsed = simctlRuntimesSchema.safeParse(JSON.parse(runtimes.stdout))
    const available = !parsed.success || parsed.data.runtimes.some((runtime) => runtime.isAvailable !== false && (runtime.platform ?? 'iOS') === 'iOS')
    if (!available) return 'No iOS simulator runtime is installed. Install one in Xcode → Settings → Components.'
  } catch {
    // An unreadable list does not prove the runtime is missing.
  }
  return null
}

export function androidUnavailableReason(sdk: AndroidSdk): string | null {
  if (!sdk.root) return 'Android SDK was not found. Install it with Android Studio or set ANDROID_HOME on this host.'
  if (!sdk.adb) return `Android SDK Platform-Tools are missing from ${sdk.root}. Install them in Android Studio's SDK Manager.`
  if (!sdk.emulator) return `Android Emulator is missing from ${sdk.root}. Install it in Android Studio's SDK Manager.`
  if (!sdk.avdmanager) {
    return sdk.legacyAvdmanager
      ? `The Android SDK command-line tools in ${sdk.root} are an old, unsupported version. Install "Android SDK Command-line Tools (latest)".`
      : `Android SDK Command-line Tools (latest) are missing from ${sdk.root}. Install them in Android Studio's SDK Manager.`
  }
  return null
}

export async function probePlatform(platform: DevicePlatform, deps: ProbeDeps): Promise<DevicePlatformAvailability> {
  const reason = platform === 'ios' ? await iosUnavailableReason(deps) : androidUnavailableReason(findAndroidSdk(deps))
  return reason === null ? { platform, available: true } : { platform, available: false, reason }
}
