import type { KeyCombo } from './types'

/**
 * Everything about keys that differs by operating system: which key `mod` is,
 * how a combo is labelled, what Electron calls the meta key, and the default
 * summon shortcut. The matcher and formatter in `match.ts` take one of these,
 * so each platform's behaviour can be tested on any machine.
 */
export interface KeyPlatform {
  id: 'mac' | 'windows' | 'linux'
  /** The key `mod` names: Command on macOS, Ctrl elsewhere. Where it is Ctrl,
   *  a binding's `nonMac` default applies. */
  primaryModifier: 'meta' | 'ctrl'
  /** The labels of a combo's modifiers, in display order. */
  modifierLabels(combo: KeyCombo): string[]
  /** A key label this platform prints its own way, or undefined. */
  keyLabel(code: string): string | undefined
  /** Between the labels of one combo written inline. */
  separator: string
  /** Electron's accelerator name for the meta key. */
  metaAccelerator: 'Command' | 'Super'
  /** The default OS summon shortcut. */
  summonCombo: KeyCombo
}

export const MAC_KEYS: KeyPlatform = {
  id: 'mac',
  primaryModifier: 'meta',
  modifierLabels(combo) {
    const labels: string[] = []
    if (combo.mod || combo.meta) labels.push('⌘')
    if (combo.ctrl) labels.push('⌃')
    if (combo.alt) labels.push('⌥')
    if (combo.shift) labels.push('⇧')
    return labels
  },
  keyLabel: (code) => (code === 'Backspace' ? '⌫' : undefined),
  separator: '',
  metaAccelerator: 'Command',
  summonCombo: { alt: true, code: 'Space' },
}

/** Windows and Linux name their modifiers. `mod` is Ctrl, and the meta key is
 *  the Windows key, which Linux calls Super. */
function namedModifierKeys(id: 'windows' | 'linux', metaLabel: string): KeyPlatform {
  return {
    id,
    primaryModifier: 'ctrl',
    modifierLabels(combo) {
      const labels: string[] = []
      if (combo.mod || combo.ctrl) labels.push('Ctrl')
      if (combo.alt) labels.push('Alt')
      if (combo.shift) labels.push('Shift')
      if (combo.meta) labels.push(metaLabel)
      return labels
    },
    keyLabel: () => undefined,
    separator: '+',
    // Electron's `Command` exists on macOS only.
    metaAccelerator: 'Super',
    // Alt+Space opens the window menu on Windows and many Linux desktops.
    summonCombo: { alt: true, shift: true, code: 'Space' },
  }
}

export const WINDOWS_KEYS = namedModifierKeys('windows', 'Win')
export const LINUX_KEYS = namedModifierKeys('linux', 'Super')

/** The key platform a `navigator.platform` value names. Anything that is not
 *  macOS or Windows (Linux, ChromeOS, a BSD) takes the Linux names. */
export function keyPlatformForNavigator(navigatorPlatform: string): KeyPlatform {
  if (navigatorPlatform.startsWith('Mac')) return MAC_KEYS
  if (navigatorPlatform.startsWith('Win')) return WINDOWS_KEYS
  return LINUX_KEYS
}

/** The key platform a Node `process.platform` value names, for the main process. */
export function keyPlatformForNode(platform: string): KeyPlatform {
  if (platform === 'darwin') return MAC_KEYS
  if (platform === 'win32') return WINDOWS_KEYS
  return LINUX_KEYS
}

/** This client's keys. The renderer reads them from the browser. */
export const CURRENT_KEYS = keyPlatformForNavigator(globalThis.navigator?.platform ?? '')
