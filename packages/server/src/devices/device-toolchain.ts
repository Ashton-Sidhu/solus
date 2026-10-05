import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  AGENT_DEVICE_VERSION,
  DEVICE_HUB_VERSION,
  type DeviceToolVersion,
  type DeviceToolVersions,
} from '@solus/contracts/device-types'
import { boundedDetail, type DeviceCommandRunner } from './device-process'

/**
 * Pinned installs of the two external device tools, adapted from T3 Code
 * (MIT, pingdotgg/t3code@43bd667, apps/server/src/device/DeviceToolchain.ts).
 *
 * Each tool is npm-installed at its pinned version into
 * `<toolsDir>/<name>/<version>` and run from there with a resolved Node, never
 * `npx`. Install stages into a temporary sibling, writes a sentinel only after
 * npm exits 0, then renames into place: an entry file alone does not prove a
 * complete tree. There is no fallback to another installed version.
 */

export type DeviceToolName = 'hub' | 'agent'

/** Versions of the helpers running right now, when they are. */
export interface RunningToolVersions {
  hub?: string
  agent?: string
}

interface ToolSpec {
  packageName: string
  version: string
  entry: readonly string[]
}

const SPECS = {
  hub: { packageName: 'expo-device-hub', version: DEVICE_HUB_VERSION, entry: ['dist', 'server', 'cli.mjs'] },
  agent: { packageName: 'agent-device', version: AGENT_DEVICE_VERSION, entry: ['bin', 'agent-device.mjs'] },
} as const satisfies Record<DeviceToolName, ToolSpec>

export interface DeviceToolPaths {
  installDir: string
  entryPath: string
  sentinelPath: string
}

const INSTALL_TIMEOUT_MS = 10 * 60_000

export class DeviceToolInstallError extends Error {
  constructor(readonly tool: DeviceToolName, readonly step: string, detail?: string) {
    super(`Installing ${SPECS[tool].packageName} failed while ${step}${detail ? `: ${detail}` : ''}.`)
  }
}

export class DeviceToolchain {
  /** One install per tool, shared by concurrent callers. */
  private readonly installs = new Map<DeviceToolName, Promise<DeviceToolPaths>>()

  constructor(
    private readonly toolsDir: string,
    private readonly run: DeviceCommandRunner,
    private readonly env: () => NodeJS.ProcessEnv = () => process.env,
  ) {}

  paths(tool: DeviceToolName, version: string = SPECS[tool].version): DeviceToolPaths {
    const spec = SPECS[tool]
    const installDir = join(this.toolsDir, spec.packageName, version)
    return {
      installDir,
      entryPath: join(installDir, 'node_modules', spec.packageName, ...spec.entry),
      sentinelPath: join(installDir, '.install-complete'),
    }
  }

  async isInstalled(tool: DeviceToolName, version: string = SPECS[tool].version): Promise<boolean> {
    const paths = this.paths(tool, version)
    if (!existsSync(paths.entryPath)) return false
    const sentinel = await readFile(paths.sentinelPath, 'utf8').catch(() => null)
    return sentinel?.trim() === version
  }

  /** Read completed installs. Never downloads or starts anything. */
  async versions(running: RunningToolVersions = {}): Promise<DeviceToolVersions> {
    const inspect = async (tool: DeviceToolName): Promise<DeviceToolVersion> => {
      const spec = SPECS[tool]
      const names: string[] = await readdir(join(this.toolsDir, spec.packageName)).catch(() => [])
      const installed: string[] = []
      for (const name of names) {
        if (/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(name) && (await this.isInstalled(tool, name))) installed.push(name)
      }
      installed.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      return { requiredVersion: spec.version, installedVersions: installed, runningVersion: running[tool] ?? null }
    }
    return { hub: await inspect('hub'), agent: await inspect('agent') }
  }

  /** Install the pinned version if it is missing. Concurrent callers share one job. */
  ensure(tool: DeviceToolName): Promise<DeviceToolPaths> {
    const existing = this.installs.get(tool)
    if (existing) return existing
    const job = this.install(tool).finally(() => {
      if (this.installs.get(tool) === job) this.installs.delete(tool)
    })
    this.installs.set(tool, job)
    return job
  }

  private async install(tool: DeviceToolName): Promise<DeviceToolPaths> {
    const spec = SPECS[tool]
    const paths = this.paths(tool)
    if (await this.isInstalled(tool)) return paths
    const parent = dirname(paths.installDir)
    try {
      await rm(paths.installDir, { recursive: true, force: true })
      await mkdir(parent, { recursive: true })
    } catch (error) {
      throw new DeviceToolInstallError(tool, 'preparing the install directory', boundedDetail(String(error)))
    }
    const staging = await mkdtemp(join(parent, '.staging-'))
    try {
      const result = await this.run(
        'npm',
        ['install', '--prefix', staging, '--no-fund', '--no-audit', '--no-save', `${spec.packageName}@${spec.version}`],
        { timeoutMs: INSTALL_TIMEOUT_MS, env: this.env(), cwd: parent },
      )
      if (result.code !== 0) {
        throw new DeviceToolInstallError(tool, 'running npm install', boundedDetail(result.stderr || result.stdout))
      }
      if (!existsSync(join(staging, 'node_modules', spec.packageName, ...spec.entry))) {
        throw new DeviceToolInstallError(tool, 'verifying the installed entry point')
      }
      await writeFile(join(staging, '.install-complete'), `${spec.version}\n`)
      try {
        await rename(staging, paths.installDir)
      } catch (error) {
        // Another Solus process may have published the same version first.
        if (!(await this.isInstalled(tool))) {
          throw new DeviceToolInstallError(tool, 'publishing the install', boundedDetail(String(error)))
        }
      }
      return paths
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {})
    }
  }
}
