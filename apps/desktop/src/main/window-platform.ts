import type { Display, Point } from 'electron'

interface DesktopScreen {
  getPrimaryDisplay(): Display
  getCursorScreenPoint(): Point
  getDisplayNearestPoint(point: Point): Display
}

export function isWayland(env: NodeJS.ProcessEnv = process.env): boolean {
  return process.platform === 'linux' && (env.XDG_SESSION_TYPE === 'wayland' || Boolean(env.WAYLAND_DISPLAY))
}

/** Wayland does not expose a global pointer position to applications. */
export function initialWindowBounds(desktopScreen: DesktopScreen, wayland = isWayland()): Electron.Rectangle | Pick<Electron.Rectangle, 'width' | 'height'> {
  const display = wayland
    ? desktopScreen.getPrimaryDisplay()
    : desktopScreen.getDisplayNearestPoint(desktopScreen.getCursorScreenPoint())
  const { x, y, width, height } = display.workArea
  const w = Math.round(width * 0.92)
  const h = Math.round(height * 0.9)
  return wayland ? { width: w, height: h } : { x: x + Math.round((width - w) / 2), y: y + Math.round((height - h) / 2), width: w, height: h }
}
