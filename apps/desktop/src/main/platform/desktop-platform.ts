import type { App, BrowserWindow, BrowserWindowConstructorOptions, NativeImage } from 'electron'
import type { DetectedEditor, DetectedTerminal, ResolvedTerminal, TerminalAppId, TerminalLaunchRequest } from '@solus/contracts/types'
import type { KeyPlatform } from '@solus/workspace-ui/lib/keybindings/key-platform'
import type { EditorApp } from '@solus/desktop-main/editor-apps'
import type { AppLaunchers, SolusInstall } from '@solus/desktop-main/app-shortcuts/launchers'
import { darwinPlatform } from './darwin'
import { linuxPlatform } from './linux'
import { win32Platform } from './win32'

/**
 * Everything the desktop shell does differently on macOS, Linux, and Windows
 * (docs/plans/windows.md §5.12). The main process asks this adapter instead of
 * reading `process.platform`, so each operating system's behaviour is one file
 * (`darwin.ts`, `linux.ts`, `win32.ts`) and can be tested on any machine.
 */
export interface DesktopPlatform {
  id: 'darwin' | 'linux' | 'win32'
  /** Key labels, defaults, and accelerator names for this operating system. */
  keys: KeyPlatform

  /** Before the app is ready: identity, Chromium switches, environment. */
  prepare(app: App): void
  /** After the app is ready, before the first window. */
  ready(app: App): void
  /** A second launch shows the first app's window instead of booting a second
   *  server. macOS sends one app a reopen, so it needs no lock. */
  singleInstance: boolean
  /** Closing the last window quits the app, except where the app lives on in the menu bar. */
  quitsWhenWindowsClose: boolean
  /** Window options for this platform's title bar. */
  windowOptions: Partial<BrowserWindowConstructorOptions>

  /** Let the app take the foreground before its window takes focus. */
  bringToFront(app: App, window: BrowserWindow): void
  /** Hide the whole app after its window hides. */
  hideApp(app: App): void
  /** The development "Hide Solus until shown" keeps the app hidden through a
   *  summon. Only macOS can hide an app without leaving a window to restore. */
  holdsHiddenUntilTrayShow: boolean

  /** The tray icon, from the app's resources folder. */
  trayIcon(appPath: string): NativeImage
  /** The tray icon shows the window on a left click (its menu is on the right click). */
  trayShowsOnClick: boolean
  /** The count of sessions that need attention, on the dock or taskbar. `description` names the count where the operating system reads it aloud. */
  setActivityBadge(app: App, window: BrowserWindow | null, count: number, description?: string): void
  /** An app window has its own taskbar button, which shows the app's own badge (Windows). Elsewhere the apps' counts add into the badge of Solus. */
  appBadgesOnOwnWindow: boolean
  /** Solus opens at login with `arguments`, for an app that starts at login (docs/plans/app-desktop-capabilities.md §4). `requires-approval`: macOS waits for the person in System Settings. */
  setOpenAtLogin(app: App, isOn: boolean, install: LoginItemInstall): Promise<'done' | 'requires-approval'>

  terminal: TerminalIntegration
  editors: EditorIntegration
  /** The launchers of app shortcuts, where this operating system lists apps (docs/app-shortcuts.md §4). */
  appLaunchers(install: SolusInstall): AppLaunchers
  /**
   * Makes this Solus the program that opens `solus:` links (docs/app-shortcuts.md
   * §4): an app link of a launcher, and a shortcut link from a browser. A
   * development run never takes the scheme from the installed app.
   */
  registerLinkScheme(app: App, install: SolusInstall): Promise<void>
  /** Write a PNG of the screen, or a region the user picks, to `path`.
   *  False when the user cancelled. */
  captureScreen(path: string, signal?: AbortSignal): Promise<boolean>
}

/** "Open in terminal": a session's agent, a worktree's shell, a terminal editor. */
export interface TerminalIntegration {
  /** Which terminal a launch will use, as the clients name it. */
  resolve(fallbackTerminalId: TerminalAppId): Promise<ResolvedTerminal>
  launch(request: TerminalLaunchRequest): Promise<boolean>
  /** The terminals Settings offers. */
  detect(cliPath: string): Promise<DetectedTerminal[]>
  /** The command that opens a login shell in a worktree. Empty opens the terminal's own shell. */
  shellCommand(env: NodeJS.ProcessEnv): string
  /** Hide Solus after a launch so the terminal is in front. */
  hidesAppAfterLaunch: boolean
}

/** "Open in editor" for GUI editors. Terminal editors go through `TerminalIntegration`. */
export interface EditorIntegration {
  /** The editor as Settings lists it, or null when it is not installed. */
  detect(app: EditorApp, cliPath: string): DetectedEditor | null
  open(app: EditorApp, filePaths: string[], cliPath: string): Promise<boolean>
}

/** What a login item of this copy of Solus starts. */
export interface LoginItemInstall extends Pick<SolusInstall, 'isPackaged' | 'executablePath' | 'launchArguments' | 'homeDirectory' | 'env'> {
  /** The argument that tells Solus it started at login, after `launchArguments`. */
  loginArgument: string
}

export function desktopPlatformFor(platform: string): DesktopPlatform {
  if (platform === 'darwin') return darwinPlatform
  if (platform === 'win32') return win32Platform
  return linuxPlatform
}

/** The adapter for the operating system this process runs on. */
export const desktopPlatform = desktopPlatformFor(process.platform)
