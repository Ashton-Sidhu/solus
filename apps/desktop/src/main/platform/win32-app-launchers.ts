import { existsSync } from 'fs'
import { mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import type { AppDetailsOptions, ShortcutDetails } from 'electron'
import { appLinkOf, type AppShortcutTarget } from '@solus/contracts/app-shortcuts'
import { ICO_SIZES, icoFile } from '@solus/desktop-main/app-shortcuts/icon-files'
import { appShortcutId, appShortcutIdentifier, windowsShortcutArguments } from '@solus/desktop-main/app-shortcuts/launcher-files'
import { freeLauncherPath, isDirectChild, launcherFolderName, type AppLaunchers, type SolusInstall } from '@solus/desktop-main/app-shortcuts/launchers'

/** The icon file of an app's shortcut, which its window shows on the taskbar too. */
function windowsShortcutIconPath(install: Pick<SolusInstall, 'filesDirectory'>, target: AppShortcutTarget): string {
  return join(install.filesDirectory, `${appShortcutId(target)}.ico`)
}

/** The part of Electron's `shell` that reads and writes a Windows shortcut. */
export interface ShortcutShell {
  readShortcutLink(shortcutPath: string): Pick<ShortcutDetails, 'appUserModelId'>
  writeShortcutLink(shortcutPath: string, operation: 'create', options: ShortcutDetails): boolean
}

/**
 * Windows lists the shortcuts in the Start menu folder of the person. The
 * shortcut starts Solus with the app link as an argument: a Solus that runs
 * gets it as a second launch. Its AppUserModelID is the app's own, so the
 * app's window has its own taskbar button with the shortcut's icon.
 */
export function windowsAppLaunchers(
  install: Pick<SolusInstall, 'isPackaged' | 'executablePath' | 'launchArguments' | 'filesDirectory' | 'appDataDirectory'>,
  shell: ShortcutShell,
): AppLaunchers {
  const directory = join(install.appDataDirectory, 'Microsoft', 'Windows', 'Start Menu', 'Programs', launcherFolderName(install))
  const isOwned = (target: AppShortcutTarget, shortcut: string) => {
    try {
      return shell.readShortcutLink(shortcut).appUserModelId === appShortcutIdentifier(target)
    } catch {
      return false
    }
  }
  const removeShortcut = async (target: AppShortcutTarget, path: string) => {
    if (isDirectChild(directory, path) && isOwned(target, path)) await rm(path, { force: true })
  }

  return {
    async write(launcher) {
      const { target } = launcher
      await mkdir(directory, { recursive: true })
      await mkdir(install.filesDirectory, { recursive: true })
      const icon = windowsShortcutIconPath(install, target)
      await writeFile(icon, icoFile(ICO_SIZES.map((size) => ({ size, png: launcher.iconPng(size) }))))
      const shortcut = freeLauncherPath(directory, launcher, '.lnk', (path) => isOwned(target, path))
      if (!shortcut) throw new Error('Other files hold every name this shortcut can have.')
      const written = shell.writeShortcutLink(shortcut, 'create', {
        target: install.executablePath,
        args: windowsShortcutArguments([...install.launchArguments, appLinkOf(target)]),
        description: launcher.name,
        icon,
        iconIndex: 0,
        appUserModelId: appShortcutIdentifier(target),
      })
      if (!written) throw new Error('Windows did not write the shortcut.')
      // The icon file stays: the shortcut at the new name uses it.
      if (launcher.previousPath && launcher.previousPath !== shortcut) await removeShortcut(target, launcher.previousPath)
      return shortcut
    },
    async remove(target, path) {
      await removeShortcut(target, path)
      await rm(windowsShortcutIconPath(install, target), { force: true })
    },
    windowIdentity(target, name) {
      const icon = windowsShortcutIconPath(install, target)
      const iconPath = existsSync(icon) ? icon : null
      const taskbar: AppDetailsOptions = {
        appId: appShortcutIdentifier(target),
        relaunchCommand: windowsShortcutArguments([install.executablePath, ...install.launchArguments, appLinkOf(target)]),
        relaunchDisplayName: name || 'Solus',
      }
      // An app with no shortcut has no icon file: its taskbar button shows the icon of Solus.
      if (iconPath) {
        taskbar.appIconPath = iconPath
        taskbar.appIconIndex = 0
      }
      return { iconPath, taskbar }
    },
  }
}
