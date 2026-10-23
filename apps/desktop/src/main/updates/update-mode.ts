/** Distribution packages are installed by the user; only AppImage can replace itself. */
export function desktopUpdateMode(platform: string, packaged: boolean, appImage?: string): 'automatic' | 'manual' | 'development' {
  if (!packaged) return 'development'
  return platform === 'linux' && !appImage ? 'manual' : 'automatic'
}
