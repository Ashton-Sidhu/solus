export const DEFAULT_DESKTOP_SERVER_PORT = 3001

export function desktopServerPort(configuredPort = process.env.SOLUS_PORT): number {
  return parseInt(configuredPort ?? '') || DEFAULT_DESKTOP_SERVER_PORT
}
