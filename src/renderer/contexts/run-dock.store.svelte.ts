import { createContext } from 'svelte'

/**
 * UI state for the bottom run-log dock. The dock spans the conversation width
 * and is summoned from the Run section (controls-only) in the project panel.
 * Open state + height are mirrored into settings for persistence by EditorLayout.
 */
export class RunDockStore {
  open = $state(false)
  /** Which run's logs are shown. Null falls back to the first run in the dock. */
  activeCommandId = $state<string | null>(null)

  /** Open the dock focused on a specific run (clicking a service row). */
  openFor(commandId: string): void {
    this.activeCommandId = commandId
    this.open = true
  }

  toggle(): void {
    this.open = !this.open
  }

  close(): void {
    this.open = false
  }
}

export const [getRunDockStore, setRunDockStore] = createContext<RunDockStore>()
