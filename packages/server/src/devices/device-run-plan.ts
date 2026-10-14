import { readdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { DeviceProjectInfo, DeviceRunProfile, DeviceRunStartRequest, DeviceSummary } from '@solus/contracts/device-types'
import { profilesForDevice } from '@solus/client-core/device-builds'
import { RUN_PROFILE_PRESETS, projectPreset, profileDraft, withConfiguration, splitCommand } from '@solus/client-core/device-run-profiles'
import { loadProjectConfig } from '../project-config/project-config'
import { DeviceDomainError } from './device-errors'
import { scanDeviceProject } from './device-project'

export interface DeviceRunPlan { profile: DeviceRunProfile; cwd: string; appFolder: string; automatic: boolean; info: DeviceProjectInfo }

async function automaticProfile(checkoutRoot: string, info: DeviceProjectInfo, device: DeviceSummary): Promise<DeviceRunProfile> {
  const profiles = RUN_PROFILE_PRESETS.map((preset) => preset.profile)
  const preset = profilesForDevice(profiles, device)[0]!
  const preliminary = projectPreset(preset, info)
  const entries = await readdir(join(checkoutRoot, preliminary.cwd)).catch(() => [])
  const profile = projectPreset(preset, info, entries)
  if (!info.usesExpo && !(await stat(join(checkoutRoot, profile.cwd)).catch(() => null))?.isDirectory()) {
    throw new DeviceDomainError('invalid_request', `Set up the ${device.platform} project first. Add its build command and output to the project's .solus/config.json.`)
  }
  return profile
}

function buildFolder(checkoutRoot: string, profile: DeviceRunProfile): string {
  const cwd = resolve(checkoutRoot, profile.cwd)
  const inside = relative(checkoutRoot, cwd)
  if (inside.startsWith('..') || isAbsolute(inside)) throw new DeviceDomainError('invalid_request', `The build folder ${profile.cwd} is outside the project.`)
  if (isAbsolute(profile.artifact) || profile.artifact.replaceAll('\\', '/').split('/').includes('..')) throw new DeviceDomainError('invalid_request', 'The build output must stay inside the build folder.')
  return cwd
}

/**
 * The package that owns the build folder: the nearest folder at or above it,
 * inside the checkout, with a `package.json`. A monorepo root can list Expo
 * too, so the scan's first manifest can name the root instead of the app.
 */
async function packageFolderOf(checkoutRoot: string, buildFolder: string): Promise<string | null> {
  for (let folder = buildFolder; folder !== checkoutRoot && !relative(checkoutRoot, folder).startsWith('..'); folder = dirname(folder)) {
    if ((await stat(join(folder, 'package.json')).catch(() => null))?.isFile()) return folder
  }
  return null
}

/** Select the device target first, then configure Debug or standalone Release. */
export async function planDeviceRun(projectRoot: string, checkoutRoot: string, request: DeviceRunStartRequest, device: DeviceSummary): Promise<DeviceRunPlan> {
  const config = await loadProjectConfig(projectRoot)
  const matching = profilesForDevice(config?.deviceRuns, device)
  const saved = request.profileName ? matching.find((candidate) => candidate.name === request.profileName) : matching[0]
  if (request.profileName && !saved) throw new DeviceDomainError('invalid_request', 'That target configuration does not match the selected device.')
  const info = await scanDeviceProject(checkoutRoot)
  const profile = saved ?? await automaticProfile(checkoutRoot, info, device)
  const configuration = withConfiguration(profileDraft(profile), 'Release')
  const configured = { ...profile, command: splitCommand(configuration.commandText), artifact: configuration.artifact }
  const cwd = buildFolder(checkoutRoot, configured)
  const manifest = info.markers.find((marker) => marker.endsWith('package.json'))
  const appFolder = await packageFolderOf(checkoutRoot, cwd) ?? (manifest ? resolve(checkoutRoot, dirname(manifest)) : checkoutRoot)
  return { profile: configured, cwd, appFolder, automatic: !saved, info }
}
