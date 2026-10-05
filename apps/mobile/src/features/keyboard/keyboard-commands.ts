import { Listeners } from '../../lib/listeners'

/**
 * Hardware keyboard commands (plan 017 stage 4), with the desktop meanings:
 * ⌘N new session, ⌘B the session sidebar, ⌘L the input, Ctrl+C stop the
 * agent, ⌘[ back. Send is ⌘↩: a plain Return must still break a line in a
 * multiline input. The native view (`modules/solus-keyboard-commands`) offers
 * only the commands some screen handles now. The newest-handler rule is
 * adapted from T3 Code `hardwareKeyboardCommands.ts` (MIT, see UPSTREAM.md).
 */
export const KEYBOARD_COMMANDS = ['send', 'newSession', 'toggleSidebar', 'focusInput', 'stop', 'back'] as const
export type KeyboardCommand = (typeof KEYBOARD_COMMANDS)[number]

/** Answers false to pass the command to the handler mounted before it. */
export type KeyboardCommandHandler = () => boolean | void

export class KeyboardCommands {
  private readonly handlers = new Map<KeyboardCommand, KeyboardCommandHandler[]>()
  private enabled: readonly KeyboardCommand[] = []
  readonly changes = new Listeners()

  /** The newest registration answers first: the screen on top. */
  register(command: KeyboardCommand, handler: KeyboardCommandHandler): () => void {
    const stack = this.handlers.get(command) ?? []
    stack.push(handler)
    this.handlers.set(command, stack)
    this.refresh()
    return () => {
      const current = this.handlers.get(command) ?? []
      const index = current.lastIndexOf(handler)
      if (index >= 0) current.splice(index, 1)
      if (current.length === 0) this.handlers.delete(command)
      this.refresh()
    }
  }

  dispatch(command: KeyboardCommand): boolean {
    const stack = this.handlers.get(command) ?? []
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      if (stack[index]?.() !== false) return true
    }
    return false
  }

  enabledCommands = (): readonly KeyboardCommand[] => this.enabled

  private refresh(): void {
    const next = KEYBOARD_COMMANDS.filter((command) => this.handlers.has(command))
    if (next.length === this.enabled.length && next.every((command, index) => command === this.enabled[index])) return
    this.enabled = next
    this.changes.notify()
  }
}
