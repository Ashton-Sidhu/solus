import { existsSync } from 'fs'
import { mkdir, rename, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { appLinkOf, type AppShortcutTarget } from '@solus/contracts/app-shortcuts'
import { appShortcutId, linuxDesktopEntry } from '@solus/desktop-main/app-shortcuts/launcher-files'
import type { AppLaunchers, SolusInstall } from '@solus/desktop-main/app-shortcuts/launchers'

/** The largest size a desktop draws a launcher at; it scales the image down for the smaller ones. */
const ICON_SIZE = 256

/**
 * Linux desktops list the desktop entries in `$XDG_DATA_HOME/applications`
 * (Desktop Entry Specification). The entry starts Solus with the app link as
 * an argument: a Solus that runs gets it as a second launch. The file name
 * holds the app's id, so no other file has it and a rename keeps the file.
 */
export function linuxAppLaunchers(
  install: Pick<SolusInstall, 'isPackaged' | 'executablePath' | 'launchArguments' | 'filesDirectory' | 'homeDirectory' | 'env'>,
): AppLaunchers {
  const directory = join(install.env.XDG_DATA_HOME || join(install.homeDirectory, '.local', 'share'), 'applications')
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
    async remove(target, path) {
      if (path !== entryPath(target)) return
      await rm(path, { force: true })
      await rm(iconPath(target), { force: true })
    },
    // The desktop groups windows by the program's window class, so the window stays in Solus's group and takes only the icon.
    windowIdentity: (target) => ({ iconPath: existsSync(iconPath(target)) ? iconPath(target) : null, taskbar: null }),
  }
}
