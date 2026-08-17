import type { HostOperatingSystem } from '../../shared/types'

export function hostOperatingSystem(platform = process.platform): HostOperatingSystem | undefined {
  if (platform === 'darwin') return 'macos'
  if (platform === 'win32') return 'windows'
  if (platform === 'linux') return 'linux'
  return undefined
}
