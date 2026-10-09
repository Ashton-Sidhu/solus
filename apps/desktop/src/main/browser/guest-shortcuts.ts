import type { Input } from 'electron'
import type { GuestShortcut } from '@solus/contracts/host-api'

interface BrowserShortcutEvent {
  preventDefault(): void
}

interface BrowserShortcutContents {
  on(
    event: 'before-input-event',
    listener: (event: BrowserShortcutEvent, input: Input) => void,
  ): void
}

/**
 * A focused `<webview>` becomes Electron's focused WebContents. Without this
 * binding, the application menu's reload role can send Cmd/Ctrl+R to the
 * browser page instead of reloading the Solus renderer. Bind the editor too:
 * the shortcut must not depend on Electron creating a default reload menu.
 */
export function isApplicationReloadInput(input: Input, platform = process.platform): boolean {
  const hasPlatformModifier = platform === 'darwin' ? input.meta : input.control
  return input.type === 'keyDown'
    && input.code === 'KeyR'
    && hasPlatformModifier
    && !input.isAutoRepeat
    && !input.alt
    && !input.shift
    && (platform === 'darwin' ? !input.control : !input.meta)
}

export function preserveApplicationReloadShortcut(
  inputContents: BrowserShortcutContents,
  reloadApplication: () => void,
): void {
  inputContents.on('before-input-event', (event, input) => {
    if (!isApplicationReloadInput(input)) return
    event.preventDefault()
    reloadApplication()
  })
}

/** Whether a guest keystroke is one of the Solus shortcuts it must give up. */
export function matchGuestShortcut(input: Input, shortcuts: readonly GuestShortcut[]): GuestShortcut | null {
  if (input.type !== 'keyDown') return null
  return shortcuts.find((shortcut) =>
    shortcut.code === input.code
    && shortcut.alt === input.alt
    && shortcut.shift === input.shift
    && shortcut.meta === input.meta
    && shortcut.ctrl === input.control,
  ) ?? null
}

/**
 * A focused `<webview>` is a separate process, so its keystrokes never reach
 * the renderer's keybinding listener and every Solus shortcut stops working
 * while a browser page has focus. Take the shortcuts the renderer named out of
 * the guest before the page sees them, and hand them back to the renderer.
 */
export function forwardGuestShortcuts(
  inputContents: BrowserShortcutContents,
  shortcuts: () => readonly GuestShortcut[],
  forward: (shortcut: GuestShortcut) => void,
): void {
  inputContents.on('before-input-event', (event, input) => {
    const shortcut = matchGuestShortcut(input, shortcuts())
    if (!shortcut) return
    event.preventDefault()
    // A held key stays with Solus but fires once, like a non-repeatable binding.
    if (!input.isAutoRepeat) forward(shortcut)
  })
}
