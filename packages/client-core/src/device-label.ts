import { localApi } from './local-api'

/**
 * What this device calls itself when it pairs. The desktop app is always
 * "Solus desktop"; a browser names itself by browser and OS so the server's
 * device list distinguishes a phone from the desktop that paired it.
 */
export function defaultDeviceLabel(): string {
  if (localApi.getPlatform() !== 'web') return 'Solus desktop'
  const ua = navigator.userAgent
  const os = /iPhone|iPad/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
    : /Mac OS/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Linux/.test(ua) ? 'Linux'
    : 'device'
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Chrome/.test(ua) ? 'Chrome'
    : /Firefox/.test(ua) ? 'Firefox'
    : /Safari/.test(ua) ? 'Safari'
    : 'Browser'
  return `${browser} on ${os}`
}
