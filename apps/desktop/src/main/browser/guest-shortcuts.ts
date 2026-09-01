import type { Input } from 'electron'

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
