import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type Platform = 'darwin' | 'linux' | 'win32'
type Arch = 'x64' | 'arm64'

export interface ResourceMonitorTarget {
  platform: Platform
  arch: Arch
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const crate = resolve(root, 'native/resource-monitor')
/** The packaged folder, as the voice helper has one: `extraResources` copies it whole. */
export const RESOURCE_MONITOR_OUTPUT = resolve(root, 'build/resource-monitor/bin')

export function resourceMonitorBinaryName(platform: Platform): string {
  return platform === 'win32' ? 'solus-resource-monitor.exe' : 'solus-resource-monitor'
}

/** A Linux target is static musl: one binary runs on glibc and musl hosts, and
 *  `rust-lld` links it from any machine. */
export function resourceMonitorRustTarget({ platform, arch }: ResourceMonitorTarget): string {
  const cpu = arch === 'arm64' ? 'aarch64' : 'x86_64'
  if (platform === 'darwin') return `${cpu}-apple-darwin`
  if (platform === 'linux') return `${cpu}-unknown-linux-musl`
  return `${cpu}-pc-windows-msvc`
}

function cargoAvailable(): boolean {
  return spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status === 0
}

/**
 * Builds only the resource monitor, never the Electron or web bundles. Returns
 * false when there is no cargo outside CI: a host without the monitor still
 * runs, so a local package warns. A release cannot ship without it.
 */
export function buildResourceMonitor(target: ResourceMonitorTarget, hostPlatform = process.platform): boolean {
  if (target.platform !== hostPlatform && target.platform !== 'linux')
    throw new Error(`Build the resource monitor for ${target.platform} on ${target.platform}`)
  rmSync(RESOURCE_MONITOR_OUTPUT, { recursive: true, force: true })
  if (!cargoAvailable()) {
    if (process.env.CI) throw new Error('A release needs cargo to build the resource monitor')
    console.warn('[resource-monitor] cargo was not found: this package has no process telemetry.')
    return false
  }
  const rustTarget = resourceMonitorRustTarget(target)
  // Without rustup the toolchain must already have the target; cargo says so.
  spawnSync('rustup', ['target', 'add', rustTarget], { stdio: 'inherit' })
  const env = { ...process.env }
  if (target.platform === 'linux') env[`CARGO_TARGET_${rustTarget.toUpperCase().replaceAll('-', '_')}_LINKER`] = 'rust-lld'
  const cargoTarget = resolve(root, 'build/resource-monitor/target')
  const result = spawnSync('cargo', [
    'build', '--locked', '--release',
    '--manifest-path', resolve(crate, 'Cargo.toml'),
    '--target', rustTarget,
    '--target-dir', cargoTarget,
  ], { cwd: root, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Resource monitor build failed (${result.status})`)
  const name = resourceMonitorBinaryName(target.platform)
  const built = resolve(cargoTarget, rustTarget, 'release', name)
  if (!existsSync(built)) throw new Error(`Resource monitor build wrote no binary at ${built}`)
  mkdirSync(RESOURCE_MONITOR_OUTPUT, { recursive: true })
  copyFileSync(built, resolve(RESOURCE_MONITOR_OUTPUT, name))
  chmodSync(resolve(RESOURCE_MONITOR_OUTPUT, name), 0o755)
  // The binary is T3 Code's work, so its MIT notice travels with it.
  copyFileSync(resolve(crate, 'LICENSE'), resolve(RESOURCE_MONITOR_OUTPUT, 'LICENSE'))
  return true
}

function platformOf(value: string): Platform {
  if (value === 'darwin' || value === 'linux' || value === 'win32') return value
  throw new Error(`Unsupported platform: ${value}`)
}

function archOf(value: string): Arch {
  if (value === 'x64' || value === 'arm64') return value
  throw new Error(`Unsupported architecture: ${value}`)
}

if (import.meta.main) {
  const flag = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
  buildResourceMonitor({ platform: platformOf(flag('platform') ?? process.platform), arch: archOf(flag('arch') ?? process.arch) })
}
