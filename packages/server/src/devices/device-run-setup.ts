import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { DeviceRunProfile } from '@solus/contracts/device-types'
import { projectPreset } from '@solus/client-core/device-run-profiles'
import { DeviceDomainError } from './device-errors'

export interface DeviceRunSetup {
  checkoutRoot: string
  cwd: string
  appFolder: string
  profile: DeviceRunProfile
  usesExpo: boolean
  automatic: boolean
  hasChangedCommit: boolean
  cancelled: () => boolean
  command: (args: string[], cwd: string) => Promise<number>
}

async function dependencies(setup: DeviceRunSetup): Promise<void> {
  const packageFolder = setup.appFolder
  if (!(await stat(join(packageFolder, 'package.json')).catch(() => null))?.isFile()) return
  if (!setup.hasChangedCommit && await stat(join(packageFolder, 'node_modules')).catch(() => null)) return
  let command = ['npm', 'install']
  if (await stat(join(setup.checkoutRoot, 'package-lock.json')).catch(() => null)) command = ['npm', 'ci']
  const bunLock = await stat(join(setup.checkoutRoot, 'bun.lock')).catch(() => null)
  const legacyBunLock = await stat(join(setup.checkoutRoot, 'bun.lockb')).catch(() => null)
  if (bunLock || legacyBunLock) command = ['bun', 'install', '--frozen-lockfile']
  const code = await setup.command(command, setup.checkoutRoot)
  if (code !== 0 && !setup.cancelled()) throw new DeviceDomainError('command_failed', 'Dependency setup failed. Open Details to see why.')
}

async function nativeProject(setup: DeviceRunSetup): Promise<void> {
  let regenerate = false
  if (setup.usesExpo && setup.automatic && setup.hasChangedCommit) {
    const ignored = await setup.command(['git', 'check-ignore', '-q', '--', relative(setup.checkoutRoot, setup.cwd)], setup.checkoutRoot)
    regenerate = ignored === 0
  }
  const nativeFolder = await stat(setup.cwd).catch(() => null)
  if (setup.usesExpo && (regenerate || !nativeFolder?.isDirectory())) {
    const code = await setup.command(['npx', 'expo', 'prebuild', '--platform', setup.profile.platform, '--no-install'], setup.appFolder)
    if (code !== 0 && !setup.cancelled()) throw new DeviceDomainError('command_failed', 'Native project setup failed. Open Details to see why.')
  }
  if (setup.cancelled() || setup.profile.platform !== 'ios') return
  const podfile = await stat(join(setup.cwd, 'Podfile')).catch(() => null)
  const pods = await stat(join(setup.cwd, 'Pods')).catch(() => null)
  if (podfile && (setup.hasChangedCommit || !pods)) {
    const code = await setup.command(['pod', 'install'], setup.cwd)
    if (code !== 0 && !setup.cancelled()) throw new DeviceDomainError('command_failed', 'iOS dependency setup failed. Open Details to see why.')
  }
}

/** Setup runs only in the owned checkout and shares the run's process cancellation. */
export async function prepareDeviceRun(setup: DeviceRunSetup): Promise<DeviceRunProfile> {
  await dependencies(setup)
  if (setup.cancelled()) return setup.profile
  await nativeProject(setup)
  if (!setup.automatic || setup.profile.platform !== 'ios') return setup.profile
  const entries = await readdir(setup.cwd).catch(() => [])
  return projectPreset(setup.profile, { isMobileApp: true, platforms: ['ios'], markers: [`${setup.profile.cwd}/App.xcodeproj`] }, entries)
}
