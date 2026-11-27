import type { AppDesktopPermission, DesktopOs } from '@solus/contracts/app-desktop'

const MODIFIERS = new Map([
  ['commandorcontrol', true],
  ['cmdorctrl', true],
  ['command', true],
  ['cmd', true],
  ['control', true],
  ['ctrl', true],
  ['alt', true],
  ['option', true],
  ['altgr', true],
  ['super', true],
  ['meta', true],
  // Shift is a modifier, but not enough alone: Shift+K types a capital K.
  ['shift', false],
])
const KEYS_WITHOUT_MODIFIER = new Set([
  ...Array.from({ length: 12 }, (_, index) => `f${index + 13}`),
  'medianexttrack',
  'mediaprevioustrack',
  'mediastop',
  'mediaplaypause',
  'volumeup',
  'volumedown',
  'volumemute',
])

/**
 * Why an accelerator cannot be a global shortcut of an app, or null when it
 * can. A shortcut that takes a key from typing in every other app is refused,
 * as Executor refuses it.
 */
export function shortcutProblem(accelerator: string): string | null {
  const parts = accelerator.split('+')
  const key = parts.at(-1)?.toLowerCase() ?? ''
  const modifiers = parts.slice(0, -1).map((part) => part.toLowerCase())
  if (key === '' || MODIFIERS.has(key) || modifiers.some((part) => !MODIFIERS.has(part)) || new Set(modifiers).size !== modifiers.length) {
    return `${accelerator} is not a keyboard shortcut. Write the modifiers, then one key, with + between them, such as CommandOrControl+Shift+K.`
  }
  if (!KEYS_WITHOUT_MODIFIER.has(key) && !modifiers.some((part) => MODIFIERS.get(part) === true)) {
    return `${accelerator} takes a key from typing in every other app. A global shortcut needs CommandOrControl, Control, Command, Alt, or Super; Shift alone is not enough. Only F13 to F24 and the media keys work alone.`
  }
  return null
}

/** The question of the permission dialog, after the app's name. */
export function permissionQuestion(permission: AppDesktopPermission, os: DesktopOs): string {
  switch (permission) {
    case 'menuBar': return os === 'darwin' ? 'wants to add an item to the menu bar.' : 'wants to add an icon to the system tray.'
    case 'shortcuts': return 'wants to use a keyboard shortcut that works while you are in other apps.'
    case 'floating': return 'wants to keep its window above other windows.'
    case 'startAtLogin': return 'wants to start when you log in to this computer.'
    case 'microphone': return 'wants to use your microphone.'
    case 'camera': return 'wants to use your camera.'
    case 'clipboardRead': return 'wants to read what you copy.'
    case 'notifications': return 'wants to show notifications.'
  }
}

const CHANGE_HINT = 'You can change this later in the app\'s menu, or in Solus Settings → General → App permissions.'

/** The detail of the permission dialog. */
export function permissionDetail(permission: AppDesktopPermission): string {
  switch (permission) {
    case 'startAtLogin': return `Solus opens at login, and opens the app with no window. ${CHANGE_HINT}`
    case 'clipboardRead': return `It can read text that you copy in any app, each time it asks. ${CHANGE_HINT}`
    default: return CHANGE_HINT
  }
}
