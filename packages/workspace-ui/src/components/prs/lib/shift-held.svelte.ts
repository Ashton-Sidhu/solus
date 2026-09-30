import { isEditableTarget } from '../../../lib/keybindings/dispatcher.svelte'

/**
 * Whether Shift alone is held, for the pull request list's row actions.
 *
 * Shift in a text field is typing, and Shift with another modifier is a global
 * shortcut, so neither counts. Released on any keystroke without Shift, on its
 * own keyup, and when the window loses focus — a Shift let go in another
 * window never reaches this one, and the actions must not stay up.
 */
export class ShiftHeld {
  isHeld = $state(false)

  /** Follow the keyboard on `target` until the returned function is called. */
  listen(target: Window): () => void {
    const onKeydown = (event: KeyboardEvent): void => {
      this.isHeld =
        event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !isEditableTarget(event.target)
    }
    const onKeyup = (event: KeyboardEvent): void => {
      if (event.key === 'Shift' || !event.shiftKey) this.isHeld = false
    }
    const release = (): void => {
      this.isHeld = false
    }
    target.addEventListener('keydown', onKeydown, true)
    target.addEventListener('keyup', onKeyup, true)
    target.addEventListener('blur', release)
    return () => {
      target.removeEventListener('keydown', onKeydown, true)
      target.removeEventListener('keyup', onKeyup, true)
      target.removeEventListener('blur', release)
      release()
    }
  }
}
