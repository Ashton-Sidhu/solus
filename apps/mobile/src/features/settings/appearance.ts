import type { PersonalSettings } from '@solus/contracts/settings'
import type { Listeners } from '../../lib/listeners'
import type { PersonalSettingsStore } from './personal-settings'

/** System follows the device; Light and Dark hold whatever the device does. */
export type AppearanceMode = PersonalSettings['themeMode']

export const APPEARANCE_MODES: readonly AppearanceMode[] = ['system', 'light', 'dark']

/**
 * The light or dark choice, as this device applies it. The value is the
 * person's `themeMode` (plans/018 §3.2): this adapter reads and writes the
 * personal store and holds no copy, so sync and the Appearance screen never
 * compete. `system` resolves on each device. Applying it is the platform's job
 * (`Appearance.setColorScheme`), so native controls, alerts, and the keyboard
 * follow the same choice as the app's own colors.
 */
export class AppearancePreference {
  readonly changes: Listeners
  private applied: AppearanceMode | null = null

  constructor(
    private readonly personal: PersonalSettingsStore,
    private readonly apply: (mode: AppearanceMode) => void,
  ) {
    this.changes = personal.changes
    // A change from sync or another account's profile is applied too.
    personal.changes.subscribe(() => {
      if (this.applied !== null) this.applySaved()
    })
  }

  current = (): AppearanceMode => this.personal.current().themeMode

  /** Puts the current choice into effect; called at launch, then on each change. */
  applySaved(): void {
    const mode = this.current()
    if (mode === this.applied) return
    this.applied = mode
    this.apply(mode)
  }

  set(mode: AppearanceMode): void {
    if (mode === this.current()) return
    this.personal.set({ themeMode: mode })
  }
}
