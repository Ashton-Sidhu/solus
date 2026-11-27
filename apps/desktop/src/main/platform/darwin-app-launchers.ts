import { readFileSync } from 'fs'
import { chmod, mkdir, rename, rm, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { appLinkOf, type AppShortcutTarget } from '@solus/contracts/app-shortcuts'
import { ICNS_SIZES, icnsFile } from '@solus/desktop-main/app-shortcuts/icon-files'
import {
  appShortcutId,
  appShortcutIdentifier,
  bundleIdentifierOf,
  macLauncherInfoPlist,
  macLauncherScript,
} from '@solus/desktop-main/app-shortcuts/launcher-files'
import {
  freeLauncherPath,
  isDirectChild,
  launcherFolderName,
  trashLauncher,
  type AppLaunchers,
  type SolusInstall,
  type TrashShell,
} from '@solus/desktop-main/app-shortcuts/launchers'

const RELEASE_BUNDLE_ID = 'com.solus.app'

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

/**
 * The bundle identifier of the Solus that runs, from the `Info.plist` beside
 * its program. A development run is Electron's own bundle, so its launchers
 * open that one and never the installed Solus.
 */
export function solusBundleIdentifier(executablePath: string): string {
  const infoPlist = readText(resolve(executablePath, '../../Info.plist'))
  return (infoPlist && bundleIdentifierOf(infoPlist)) ?? RELEASE_BUNDLE_ID
}

/**
 * macOS lists the apps in `~/Applications`, so a launcher is a small app
 * bundle there: Spotlight, Launchpad, and the Dock treat it as an app. Its
 * program opens the app link with Solus and exits. A removed launcher goes to
 * the Trash, where the Finder can put it back.
 */
export function macAppLaunchers(install: Pick<SolusInstall, 'isPackaged' | 'executablePath' | 'homeDirectory'>, shell: TrashShell): AppLaunchers {
  const directory = join(install.homeDirectory, 'Applications', launcherFolderName(install))
  const isOwned = (target: AppShortcutTarget, bundle: string) => {
    if (!isDirectChild(directory, bundle)) return false
    const infoPlist = readText(join(bundle, 'Contents', 'Info.plist'))
    return infoPlist !== null && bundleIdentifierOf(infoPlist) === appShortcutIdentifier(target)
  }

  return {
    async write(launcher) {
      const { target } = launcher
      await mkdir(directory, { recursive: true })
      const bundle = freeLauncherPath(directory, launcher, '.app', (path) => isOwned(target, path))
      if (!bundle) throw new Error('Other files hold every name this shortcut can have.')
      // Built beside its place and renamed into it, so the Finder never shows half a launcher.
      const staging = join(directory, `.${appShortcutId(target)}.staging.app`)
      await rm(staging, { recursive: true, force: true })
      await mkdir(join(staging, 'Contents', 'MacOS'), { recursive: true })
      await mkdir(join(staging, 'Contents', 'Resources'), { recursive: true })
      const program = join(staging, 'Contents', 'MacOS', 'launcher')
      await writeFile(program, macLauncherScript(appLinkOf(target), solusBundleIdentifier(install.executablePath)))
      await chmod(program, 0o755)
      await writeFile(
        join(staging, 'Contents', 'Resources', 'icon.icns'),
        icnsFile(ICNS_SIZES.map((size) => ({ size, png: launcher.iconPng(size) }))),
      )
      await writeFile(join(staging, 'Contents', 'Info.plist'), macLauncherInfoPlist(launcher.name, target))
      // The launcher at the new name replaces the old one, so the old one is deleted, not put in the Trash.
      const { previousPath } = launcher
      if (previousPath && previousPath !== bundle && isOwned(target, previousPath)) await rm(previousPath, { recursive: true, force: true })
      await rm(bundle, { recursive: true, force: true })
      await rename(staging, bundle)
      return bundle
    },
    async remove(target, path) {
      return isOwned(target, path) ? trashLauncher(shell, target, path) : { launcher: 'removed' }
    },
    // The window is one of Solus's: macOS has one Dock icon for each process.
    windowIdentity: () => ({ iconPath: null, taskbar: null }),
  }
}
