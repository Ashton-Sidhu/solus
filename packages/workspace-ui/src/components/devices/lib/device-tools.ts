import type { DeviceAction, DeviceColorFilter, DeviceOrientation, DeviceTextSize, DeviceToggle } from '@solus/contracts/device-types'

/** Labels and pending keys for the device Tools drawer. */

export function toggleLabel(setting: DeviceToggle): string {
  return {
    reduceMotion: 'Reduce motion',
    increaseContrast: 'Increase contrast',
    reduceTransparency: 'Reduce transparency',
    showBorders: 'Button shapes',
    voiceOver: 'VoiceOver',
    networkEnabled: 'Network',
  }[setting]
}

export function textSizeLabel(size: DeviceTextSize): string {
  return { small: 'Small', default: 'Default', large: 'Large', 'extra-large': 'Extra large' }[size]
}

export function orientationLabel(orientation: DeviceOrientation): string {
  return { portrait: 'Portrait', landscape_left: 'Landscape left', portrait_upside_down: 'Upside down', landscape_right: 'Landscape right' }[orientation]
}

export function colorFilterLabel(filter: DeviceColorFilter): string {
  return { none: 'None', grayscale: 'Grayscale', 'red-green': 'Red/green (protanopia)', 'green-red': 'Green/red (deuteranopia)', 'blue-yellow': 'Blue/yellow (tritanopia)' }[filter]
}

/** The control an action belongs to, so only that control shows as pending. */
export function pendingKey(action: DeviceAction): string {
  return action.type === 'setToggle' ? `setToggle:${action.setting}` : action.type
}
