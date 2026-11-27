import { z } from 'zod'
import type { AppShortcutTarget } from './app-shortcuts'

/**
 * The desktop capabilities of an app in its app window
 * (docs/plans/app-desktop-capabilities.md). The app's page calls
 * `@desktop/<operation>` through `window.solusApp`; the Solus page of the app
 * window relays the call to the main process, which names the app from the
 * window that sent it. Web and mobile have no app window: there every
 * capability is unavailable.
 */

/** A capability that needs the person's answer before the app uses it. In the order the menus and Settings list them. */
export const APP_DESKTOP_PERMISSIONS = [
  'menuBar',
  'shortcuts',
  'floating',
  'startAtLogin',
  'microphone',
  'camera',
  'systemAudio',
  'clipboardRead',
  'notifications',
] as const
export type AppDesktopPermission = (typeof APP_DESKTOP_PERMISSIONS)[number]
export const appDesktopPermissionSchema = z.enum(APP_DESKTOP_PERMISSIONS)

/** The person's answer for one permission of one app on this device. */
export type AppDesktopGrant = 'granted' | 'denied'
/** `prompt`: no answer yet. `unavailable`: not in a desktop app window, or not on this operating system. */
export type AppDesktopPermissionState = AppDesktopGrant | 'prompt' | 'unavailable'

export type DesktopOs = 'darwin' | 'win32' | 'linux'

/** The name of a permission in a menu and in Settings. */
export function appDesktopPermissionLabel(permission: AppDesktopPermission, os: DesktopOs): string {
  switch (permission) {
    case 'menuBar': return os === 'darwin' ? 'Menu bar item' : 'Tray icon'
    case 'shortcuts': return 'Keyboard shortcuts'
    case 'floating': return 'Keep above other windows'
    case 'startAtLogin': return 'Start at login'
    case 'microphone': return 'Microphone'
    case 'camera': return 'Camera'
    case 'systemAudio': return 'System audio'
    case 'clipboardRead': return 'Read the clipboard'
    case 'notifications': return 'Notifications'
  }
}

/** One app's grants on this device, as Settings lists them. */
export interface AppPermissionsView extends AppShortcutTarget {
  name: string
  permissions: Record<AppDesktopPermission, AppDesktopPermissionState>
}

/** A change of one grant from Settings or a menu. `prompt` clears the answer, so the app asks again. */
export interface AppPermissionChange extends AppShortcutTarget {
  permission: AppDesktopPermission
  state: AppDesktopGrant | 'prompt'
}

// ─── The calls of an app's page ───

/** Longest menu-bar title, in characters. */
export const APP_MENU_BAR_TITLE_MAX = 24
/** Largest count a badge shows. */
export const APP_BADGE_MAX = 99_999
/** Most global shortcuts one app holds. */
export const APP_SHORTCUTS_MAX = 8

const routeSchema = z.string().max(2048).regex(/^#/, 'A route is a place in the app after "#", such as "#/reports/42".')

const nameArguments = z.object({ name: appDesktopPermissionSchema })

/** One call of an app's page, `@desktop/<operation>` with its arguments, as the main process reads it. */
export const appDesktopCallSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('permission'), args: nameArguments }),
  z.object({ operation: z.literal('request-permission'), args: nameArguments }),
  z.object({ operation: z.literal('menu-bar-title'), args: z.object({ text: z.string().max(APP_MENU_BAR_TITLE_MAX, `A menu-bar title is at most ${APP_MENU_BAR_TITLE_MAX} characters.`).nullable() }) }),
  z.object({ operation: z.literal('shortcut-register'), args: z.object({ accelerator: z.string().min(1).max(100) }) }),
  z.object({ operation: z.literal('shortcut-unregister'), args: z.object({ id: z.string().min(1).max(100) }) }),
  z.object({ operation: z.literal('floating'), args: z.object({ on: z.boolean() }) }),
  z.object({ operation: z.literal('window'), args: z.object({ action: z.enum(['show', 'hide', 'focus', 'toggle']) }) }),
  z.object({ operation: z.literal('badge'), args: z.object({ count: z.number().int().min(0).max(APP_BADGE_MAX, `A badge is a whole number from 0 to ${APP_BADGE_MAX}.`).nullable() }) }),
  z.object({ operation: z.literal('notify'), args: z.object({ title: z.string().min(1).max(200), body: z.string().max(1000).default(''), route: routeSchema.nullable().default(null) }) }),
  z.object({ operation: z.literal('clipboard-read'), args: z.object({}) }),
  z.object({ operation: z.literal('system-audio'), args: z.object({}) }),
])
export type AppDesktopCall = z.infer<typeof appDesktopCallSchema>
export type AppDesktopOperation = AppDesktopCall['operation']

/** Each operation, as a call name spells it after `@desktop/`. */
export const APP_DESKTOP_OPERATIONS = [
  'permission',
  'request-permission',
  'menu-bar-title',
  'shortcut-register',
  'shortcut-unregister',
  'floating',
  'window',
  'badge',
  'notify',
  'clipboard-read',
  'system-audio',
] as const satisfies readonly AppDesktopOperation[]

/** A failure that a desktop call answers with. It crosses IPC and the frame as plain data. */
export type AppDesktopFailure =
  | { code: 'DesktopUnavailable'; message: string }
  | { code: 'DesktopPermissionDenied'; message: string; permission: AppDesktopPermission }
  | { code: 'ShortcutTaken'; message: string; accelerator: string }
  | { code: 'DesktopInvalidInput'; message: string }
  /** macOS has not allowed Solus to record the screen and system audio. */
  | { code: 'SystemAudioBlocked'; message: string }

/** A JSON value a desktop call answers. */
export type AppDesktopValue = string | number | boolean | null | AppDesktopValue[] | { [key: string]: AppDesktopValue }

/** What the main process answers a desktop call with: a value, or a failure the page can tell apart. */
export type AppDesktopResult = { ok: true; value: AppDesktopValue } | { ok: false; failure: AppDesktopFailure }

export function desktopUnavailable(): AppDesktopFailure {
  return { code: 'DesktopUnavailable', message: 'This capability is not available here: the app is not open in its own window of the Solus desktop app.' }
}

export function desktopPermissionDenied(permission: AppDesktopPermission): AppDesktopFailure {
  return { code: 'DesktopPermissionDenied', permission, message: `The person did not allow "${appDesktopPermissionLabel(permission, 'darwin')}" for this app.` }
}

/** Reads one call of an app's page; a call outside the contract is `DesktopInvalidInput`. */
export function parseAppDesktopCall(operation: string, args: AppDesktopValue): { ok: true; call: AppDesktopCall } | { ok: false; failure: AppDesktopFailure } {
  const parsed = appDesktopCallSchema.safeParse({ operation, args: args ?? {} })
  if (parsed.success) return { ok: true, call: parsed.data }
  const issue = parsed.error.issues[0]
  const message = issue?.path[0] === 'operation' ? `${operation} is not a desktop capability.` : issue?.message ?? 'The input of the call is not valid.'
  return { ok: false, failure: { code: 'DesktopInvalidInput', message } }
}

// ─── Events to an app's page ───

/** An event the Solus page of an app window passes to the app's page through `solusApp.on`. */
export type AppDesktopEvent =
  | { event: 'desktop-shortcut'; detail: { id: string } }
  | { event: 'desktop-window'; detail: { type: 'focus' | 'blur' } }
  | { event: 'open-route'; detail: { route: string } }
