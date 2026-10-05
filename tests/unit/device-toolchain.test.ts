import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_DEVICE_VERSION, DEVICE_HUB_VERSION } from '@solus/contracts/device-types'
import { DeviceToolchain, DeviceToolInstallError } from '@solus/server/devices/device-toolchain'
import type { DeviceCommandRunner } from '@solus/server/devices/device-process'

/**
 * Pinned tool installs (P22): inspection never installs, an install is
 * atomic, concurrent requests share one npm run, and a failed update never
 * falls back to an older installed version.
 */

function fakeNpm(options: { fail?: boolean } = {}) {
  const calls: string[][] = []
  const run: DeviceCommandRunner = async (_command, args) => {
    calls.push([...args])
    if (options.fail) return { code: 1, stdout: '', stderr: 'npm ERR! network\n  at stack' }
    const prefix = args[args.indexOf('--prefix') + 1]!
    const spec = args.at(-1)!
    const name = spec.slice(0, spec.lastIndexOf('@'))
    const entry = name === 'expo-device-hub' ? ['dist', 'server', 'cli.mjs'] : ['bin', 'agent-device.mjs']
    const dir = join(prefix, 'node_modules', name, ...entry.slice(0, -1))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, entry.at(-1)!), '// entry')
    return { code: 0, stdout: '', stderr: '' }
  }
  return { run, calls }
}

describe('device toolchain', () => {
  test('inspection reads versions without installing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'solus-tools-'))
    const npm = fakeNpm()
    const versions = await new DeviceToolchain(dir, npm.run).versions()
    expect(npm.calls).toHaveLength(0)
    expect(versions.hub).toEqual({ requiredVersion: DEVICE_HUB_VERSION, installedVersions: [], runningVersion: null })
    expect(versions.agent.requiredVersion).toBe(AGENT_DEVICE_VERSION)
  })

  test('an install writes the sentinel and concurrent callers share one npm run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'solus-tools-'))
    const npm = fakeNpm()
    const toolchain = new DeviceToolchain(dir, npm.run)
    const [first, second] = await Promise.all([toolchain.ensure('hub'), toolchain.ensure('hub')])
    expect(first).toEqual(second)
    expect(npm.calls).toHaveLength(1)
    expect(npm.calls[0]!.at(-1)).toBe(`expo-device-hub@${DEVICE_HUB_VERSION}`)
    expect(await toolchain.isInstalled('hub')).toBe(true)
    expect((await toolchain.versions({ hub: DEVICE_HUB_VERSION })).hub).toEqual({
      requiredVersion: DEVICE_HUB_VERSION,
      installedVersions: [DEVICE_HUB_VERSION],
      runningVersion: DEVICE_HUB_VERSION,
    })
    // No staging directory is left behind.
    expect(readdirSync(join(dir, 'expo-device-hub')).filter((name) => name.startsWith('.staging-'))).toEqual([])
  })

  test('an entry file without the sentinel is not an install', async () => {
    // WHY: npm extracts files before it finishes; a crash mid-install leaves
    // an entry point on disk that must not be run.
    const dir = mkdtempSync(join(tmpdir(), 'solus-tools-'))
    const toolchain = new DeviceToolchain(dir, fakeNpm().run)
    const paths = toolchain.paths('agent')
    mkdirSync(join(paths.entryPath, '..'), { recursive: true })
    writeFileSync(paths.entryPath, '// partial')
    expect(await toolchain.isInstalled('agent')).toBe(false)
  })

  test('a failed update reports the failure and does not fall back to an older version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'solus-tools-'))
    const old = new DeviceToolchain(dir, fakeNpm().run).paths('hub', '0.11.0')
    mkdirSync(join(old.entryPath, '..'), { recursive: true })
    writeFileSync(old.entryPath, '// old')
    writeFileSync(old.sentinelPath, '0.11.0\n')
    const toolchain = new DeviceToolchain(dir, fakeNpm({ fail: true }).run)
    const error = await toolchain.ensure('hub').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(DeviceToolInstallError)
    // Only the first line of npm's output travels.
    expect((error as Error).message).toContain('npm ERR! network')
    expect((error as Error).message).not.toContain('at stack')
    expect(await toolchain.isInstalled('hub')).toBe(false)
    expect((await toolchain.versions()).hub.installedVersions).toEqual(['0.11.0'])
    expect(existsSync(toolchain.paths('hub').installDir)).toBe(false)
  })
})
