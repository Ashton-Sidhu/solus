import { existsSync } from 'fs'
import { mkdir, rename, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { appLinkOf, type AppShortcutTarget } from '@solus/contracts/app-shortcuts'
import { appShortcutId, desktopEntryArgument, linuxDesktopEntry, linuxLinkHandlerEntry } from '@solus/desktop-main/app-shortcuts/launcher-files'
import type { AppLaunchers, SolusInstall } from '@solus/desktop-main/app-shortcuts/launchers'

/** The largest size a desktop draws a launcher at; it scales the image down for the smaller ones. */
const ICON_SIZE = 256

/** The MIME type through which a Linux desktop names the program of a URL scheme. */
export const LINUX_LINK_MIME_TYPE = 'x-scheme-handler/solus'

function applicationsDirectory(install: Pick<SolusInstall, 'homeDirectory' | 'env'>): string {
  return join(install.env.XDG_DATA_HOME || join(install.homeDirectory, '.local', 'share'), 'applications')
}

/**
 * Writes the desktop entry that opens `solus:` links (docs/app-shortcuts.md
 * §4) and gives its file name. A desktop starts it with the link as the last
 * argument, so a Solus that runs gets the link as a second launch. The entry
 * does not show in the list of apps.
 */
export async function writeLinuxLinkHandler(
  install: Pick<SolusInstall, 'executablePath' | 'launchArguments' | 'homeDirectory' | 'env'>,
): Promise<string> {
  const directory = applicationsDirectory(install)
  const name = 'solus-link-handler.desktop'
  const entry = join(directory, name)
  await mkdir(directory, { recursive: true })
  const staging = `${entry}.staging`
  await writeFile(staging, linuxLinkHandlerEntry([install.env.APPIMAGE || install.executablePath, ...install.launchArguments]), { mode: 0o644 })
  await rename(staging, entry)
  return name
}

/**
 * Linux desktops list the desktop entries in `$XDG_DATA_HOME/applications`
 * (Desktop Entry Specification). The entry starts Solus with the app link as
 * an argument: a Solus that runs gets it as a second launch. The file name
 * holds the app's id, so no other file has it and a rename keeps the file.
 */
export function linuxAppLaunchers(
  install: Pick<SolusInstall, 'isPackaged' | 'executablePath' | 'launchArguments' | 'filesDirectory' | 'homeDirectory' | 'env'>,
): AppLaunchers {
  const directory = applicationsDirectory(install)
  const entryPath = (target: AppShortcutTarget) =>
    join(directory, `${install.isPackaged ? 'solus-app' : 'solus-dev-app'}-${appShortcutId(target)}.desktop`)
  const iconPath = (target: AppShortcutTarget) => join(install.filesDirectory, `${appShortcutId(target)}.png`)

  return {
    async write(launcher) {
      const { target } = launcher
      await mkdir(directory, { recursive: true })
      await mkdir(install.filesDirectory, { recursive: true })
      await writeFile(iconPath(target), launcher.iconPng(ICON_SIZE))
      const entry = entryPath(target)
      // Written beside its place and renamed into it, so the desktop never reads half an entry.
      const staging = `${entry}.staging`
      await writeFile(staging, linuxDesktopEntry({
        name: launcher.name,
        // An AppImage runs from a mount that is gone after it quits: the image file is the program to start.
        command: [install.env.APPIMAGE || install.executablePath, ...install.launchArguments, appLinkOf(target)],
        iconPath: iconPath(target),
      }), { mode: 0o644 })
      await rename(staging, entry)
      return entry
    },
    // Deleted, not put in the Trash (docs/app-shortcuts.md §4): the Trash of
    // a Linux desktop needs its own program (`gio`), which many desktops do
    // not have, and the entry's icon is a file of Solus that goes with it. A
    // new "Add app shortcut" writes the same entry again.
    async remove(target, path) {
      if (path !== entryPath(target)) return { launcher: 'removed' }
      await rm(path, { force: true })
      await rm(iconPath(target), { force: true })
      return { launcher: 'removed' }
    },
    async forget(target) {
      await rm(iconPath(target), { force: true })
    },
    // The desktop groups windows by the program's window class, so the window stays in Solus's group and takes only the icon.
    windowIdentity: (target) => ({ iconPath: existsSync(iconPath(target)) ? iconPath(target) : null, taskbar: null }),
  }
}

/** The XDG Autostart entry that opens Solus at login, for an app that starts at login. A development run has its own. */
export function linuxAutostartPath(install: Pick<SolusInstall, 'isPackaged' | 'homeDirectory' | 'env'>): string {
  const directory = join(install.env.XDG_CONFIG_HOME || join(install.homeDirectory, '.config'), 'autostart')
  return join(directory, install.isPackaged ? 'solus.desktop' : 'solus-dev.desktop')
}

export function linuxAutostartEntry(install: Pick<SolusInstall, 'executablePath' | 'launchArguments' | 'env'> & { loginArgument: string }): string {
  const command = [install.env.APPIMAGE || install.executablePath, ...install.launchArguments, install.loginArgument]
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=Solus',
    `Exec=${command.map(desktopEntryArgument).join(' ')}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n')
}
