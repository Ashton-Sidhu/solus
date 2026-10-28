import type { App, BrowserWindow, BrowserWindowConstructorOptions, NativeImage } from 'electron'
import type { DetectedEditor, DetectedTerminal, ResolvedTerminal, TerminalAppId, TerminalLaunchRequest } from '@solus/contracts/types'
import type { KeyPlatform } from '@solus/workspace-ui/lib/keybindings/key-platform'
import type { EditorApp } from '@solus/desktop-main/editor-apps'
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
  /** The count of sessions that need attention, on the dock or taskbar. */
  setActivityBadge(app: App, window: BrowserWindow | null, count: number): void

  terminal: TerminalIntegration
  editors: EditorIntegration
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

export function desktopPlatformFor(platform: string): DesktopPlatform {
  if (platform === 'darwin') return darwinPlatform
  if (platform === 'win32') return win32Platform
  return linuxPlatform
}

/** The adapter for the operating system this process runs on. */
export const desktopPlatform = desktopPlatformFor(process.platform)
