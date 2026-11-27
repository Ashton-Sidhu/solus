import { existsSync } from 'fs'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import type { AppDetailsOptions } from 'electron'
import type { AppShortcutRemoval, AppShortcutTarget } from '@solus/contracts/app-shortcuts'
import { createLogger } from '@solus/server/logger'
import { launcherNameCandidates } from './launcher-files'

const log = createLogger('main', 'app-launchers')

/** The launcher of one app shortcut, as the operating system's adapter writes it. */
export interface AppLauncher {
  target: AppShortcutTarget
  name: string
  /** The app's tile at one pixel size, as a PNG. */
  iconPng(size: number): Uint8Array
  /** The launcher this app has now. A new name moves it, so the app never has two. */
  previousPath: string | null
}

/** How an app's window names itself to the operating system. */
export interface AppWindowIdentity {
  /** The icon of the window. Null takes the icon of Solus. */
  iconPath: string | null
  /** Windows: the window's own taskbar button, and what a pin of that button starts. Null groups the window with Solus. */
  taskbar: AppDetailsOptions | null
}

/**
 * Where one operating system lists apps, and the file it lists
 * (docs/app-shortcuts.md §4). An adapter changes only a launcher that it wrote
 * for the same app: a file of the person's with the same name stays as it is.
 */
export interface AppLaunchers {
  /** Writes the launcher and gives its path. */
  write(launcher: AppLauncher): Promise<string>
  /**
   * Removes the launcher at `path` when it is this app's, to the Trash where
   * the operating system has a dependable one. A Trash that refuses it leaves
   * it in place: that is a warning, not a failure.
   */
  remove(target: AppShortcutTarget, path: string): Promise<AppShortcutRemoval>
  /** What the window of the app shows where the operating system lists open windows. */
  windowIdentity(target: AppShortcutTarget, name: string): AppWindowIdentity
}

/** The part of Electron's `shell` that moves a file to the Trash (macOS) or the Recycle Bin (Windows). */
export interface TrashShell {
  trashItem(path: string): Promise<void>
}

/**
 * Moves a launcher that Solus owns to the Trash, so the person can take it
 * back. Solus does not delete it for good without asking: when the Trash
 * refuses it, it stays where it is and still opens its app.
 */
export async function trashLauncher(shell: TrashShell, target: AppShortcutTarget, path: string): Promise<AppShortcutRemoval> {
  try {
    await shell.trashItem(path)
    return { launcher: 'trashed' }
  } catch (error) {
    log.warn('app_launcher_trash_failed', { appId: target.appId, host: target.host, error: error instanceof Error ? error.message : String(error) })
    return { launcher: 'kept', launcherPath: path }
  }
}

/** What an adapter must know of this copy of Solus to write a launcher for it. */
export interface SolusInstall {
  /** A development run keeps its launchers apart from those of the installed app. */
  isPackaged: boolean
  /** The program of this process. macOS reads the bundle identifier of Solus beside it. */
  executablePath: string
  /** The arguments this Solus needs before an app link: none when installed, the app's folder in a development run. */
  launchArguments: readonly string[]
  /** A folder of this install for the files that a launcher points at. */
  filesDirectory: string
  homeDirectory: string
  /** Windows: the folder of roaming application data, which holds the Start menu. */
  appDataDirectory: string
  env: NodeJS.ProcessEnv
}

/** The folder name of the launchers. A development run has its own, so it never replaces a launcher of the installed app. */
export function launcherFolderName(install: Pick<SolusInstall, 'isPackaged'>): string {
  return install.isPackaged ? 'Solus Apps' : 'Solus Apps (Dev)'
}

/** `path` is a file directly in `directory`: the only place an adapter removes a launcher from. */
export function isDirectChild(directory: string, path: string): boolean {
  const fromDirectory = relative(directory, resolve(path))
  return fromDirectory !== '' && !isAbsolute(fromDirectory) && !fromDirectory.startsWith('..') && !fromDirectory.includes(sep)
}

/**
 * The first candidate path that is free or already this app's launcher. Null
 * when other files hold every candidate, which needs a file with this app's
 * full id in its name.
 */
export function freeLauncherPath(
  directory: string,
  launcher: Pick<AppLauncher, 'name' | 'target'>,
  extension: string,
  isOwned: (path: string) => boolean,
): string | null {
  for (const name of launcherNameCandidates(launcher.name, launcher.target)) {
    const candidate = join(directory, `${name}${extension}`)
    if (!existsSync(candidate) || isOwned(candidate)) return candidate
  }
  return null
}
