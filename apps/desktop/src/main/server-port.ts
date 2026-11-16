import { DEFAULT_DESKTOP_SERVER_PORT } from '@solus/contracts/types'

export function desktopServerPort(configuredPort = process.env.SOLUS_PORT): number {
  return parseInt(configuredPort ?? '') || DEFAULT_DESKTOP_SERVER_PORT
}
