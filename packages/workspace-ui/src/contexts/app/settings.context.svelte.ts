/**
 * The settings read layer (plans/018 §3.5). Every setting reads as a property —
 * `settings.themeMode` — from the store that owns it:
 *
 * - personal keys from `PersonalSettingsStore` (a local profile, synced when the
 *   person turns sync on),
 * - device keys and the client's layout keys from `DeviceSettingsStore`.
 *
 * Host-owned settings are read from focused host stores keyed by host id; none
 * is copied here. Writes go through explicit setters that name their owner.
 * Painting is the display adapters' job (`settings-display.ts`).
 */

import { z } from 'zod'
import { createAppContext } from './create-app-context'
import type { SettingsCtx } from '@solus/contracts/types'
import { setAnalyticsEnabled } from '../../lib/analytics'
import { clampZoomFactor, stepZoomFactor, ZOOM_FACTOR_DEFAULT } from '@solus/contracts/zoom'
import {
  effectiveFontFamily,
  FONT_OVERRIDE_KEYS,
  FONT_PREFERENCE_KEYS,
  isFontPreset,
  PERSONAL_SETTING_KEYS,
  type DeviceSettings,
  type ExecutionPreferences,
  type FontPreferenceKey,
  type PersonalSettingKey,
  type PersonalSettings,
} from '@solus/contracts/settings'
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENTS,
  type NotificationChannel,
  type NotificationEvent,
  type NotificationPreferences,
} from '@solus/contracts/notification-types'
import { PersonalSettingsStore, type PersonalChange } from './personal-settings.store.svelte'
import {
  DEVICE_LAYOUT_KEYS,
  DEVICE_SETTING_KEYS,
  DEVICE_LAYOUT_KEY,
  DeviceSettingsStore,
  storedJson,
  type DeviceLayout,
  type DeviceLayoutKey,
} from './device-settings.store.svelte'
import { hostSettingsStore } from './host-settings.store.svelte'
import {
  applyFontSmoothing,
  applyTheme,
  applyZoomFactor,
  FONT_DISPLAY,
  isPaintedSizeKey,
  PERSONAL_DISPLAY,
  type PaintedSizeKey,
} from './settings-display'

// Personal vocabulary lives in the contract, because the account validates the
// same values. Re-exported so renderer call sites keep one import.
export { TAB_GROUP_MODES } from '@solus/contracts/settings'
export type {
  DocumentFontFamily,
  FontFamilyPreference,
  PromptFontFamily,
  RateLimitBehavior,
  TabGroupMode,
  ThemeMode,
} from '@solus/contracts/settings'
export type { ProjectLocation, ProjectPanelSectionId } from './device-settings.store.svelte'

const storedZoomSchema = storedJson(z.object({ zoomFactor: z.number() }))

/** What reads as a property. Font keys read as the family this device paints. */
export type SettingsFields = PersonalSettings & DeviceSettings & DeviceLayout

// eslint-disable-next-line typescript/no-unsafe-declaration-merging -- the constructor defines every key before anything reads it
export interface SettingsContext extends Readonly<SettingsFields> {}

export class SettingsContext {
  readonly personal: PersonalSettingsStore
  readonly device: DeviceSettingsStore
  // Seeded from the media query so 'system' paints correctly before the main
  // process answers; `setSystemTheme` takes over from there.
  private _systemIsDark = $state(globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true)

  constructor(storage: Storage = localStorage) {
    this.device = new DeviceSettingsStore(storage)
    this.personal = new PersonalSettingsStore(storage)
    for (const key of PERSONAL_SETTING_KEYS) {
      const fontKey = FONT_PREFERENCE_KEYS.find((candidate) => candidate === key)
      Object.defineProperty(this, key, {
        get: fontKey ? () => this.fontFamilyOf(fontKey) : () => this.personal.values[key],
        enumerable: true,
      })
    }
    for (const key of DEVICE_SETTING_KEYS) Object.defineProperty(this, key, { get: () => this.device.values[key], enumerable: true })
    for (const key of DEVICE_LAYOUT_KEYS) Object.defineProperty(this, key, { get: () => this.device.layout[key], enumerable: true })

    // Must run before first paint so CSS variables resolve to the saved palette.
    applyTheme(this.isDark)
    for (const key of FONT_PREFERENCE_KEYS) this.paintFont(key)
    for (const key of PERSONAL_SETTING_KEYS) if (isPaintedSizeKey(key)) this.paintSize(key)
    applyFontSmoothing(this.device.values.fontSmoothing)
    applyZoomFactor(this.device.layout.zoomFactor)
    this.personal.onChange((change) => this.repaint(change))

    // Zoom applies per-webContents but is one device preference. Renderers
    // share this origin's localStorage, so re-apply a change here rather than
    // showing a stale scale until the next boot.
    globalThis.window?.addEventListener?.('storage', (e: StorageEvent) => {
      if (e.key !== DEVICE_LAYOUT_KEY) return
      const parsed = storedZoomSchema.safeParse(e.newValue)
      if (!parsed.success) return
      const next = clampZoomFactor(parsed.data.zoomFactor)
      if (next === this.device.layout.zoomFactor) return
      this.device.layout.zoomFactor = next
      applyZoomFactor(next)
    })
  }

  get isDark(): boolean {
    const themeMode = this.personal.values.themeMode
    return themeMode === 'dark' || (themeMode === 'system' && this._systemIsDark)
  }

  /** The person's execution preferences, as every request that runs work for them carries them. */
  get executionPreferences(): ExecutionPreferences {
    return this.personal.executionPreferences
  }

  get ctx(): SettingsCtx {
    return {
      fallbackTerminal: this.fallbackTerminal,
      activeAgent: this.activeAgent,
      reviewAgent: this.reviewAgent,
      reviewModel: this.reviewModel,
      reviewReasoning: this.reviewReasoning,
      reviewGuideInstructions: this.reviewGuideInstructions,
      reviewWarmingEnabled: false,
      executionPreferences: this.executionPreferences,
    }
  }

  /** Review warming is the named host's setting for that project path. */
  ctxForProject(serverId: string, projectPath: string): SettingsCtx {
    return { ...this.ctx, reviewWarmingEnabled: hostSettingsStore.isReviewWarmingEnabled(serverId, projectPath) }
  }

  // ── Writes, by owner ──

  /** One personal key. False when the value fails its schema; nothing changes then. */
  setPersonal<K extends Exclude<PersonalSettingKey, FontPreferenceKey>>(key: K, value: PersonalSettings[K]): boolean {
    return this.personal.set(key, value)
  }

  /** One device key. Fonts and analytics consent have their own setters below. */
  setDevice<K extends 'voiceModeEnabled' | 'autoSendVoiceTranscripts' | 'vadSilenceMs' | 'defaultEditor' | 'fallbackTerminal' | 'fontSmoothing'>(key: K, value: DeviceSettings[K]): void {
    this.device.set(key, value)
    if (key === 'fontSmoothing') applyFontSmoothing(this.device.values.fontSmoothing)
  }

  setLayout<K extends DeviceLayoutKey>(key: K, value: DeviceLayout[K]): void {
    this.device.setLayout(key, value)
    if (key === 'zoomFactor') applyZoomFactor(this.device.layout.zoomFactor)
  }

  /**
   * A font choice: a bundled preset is the person's synced preference and clears
   * this device's override; an installed family is an override on this device
   * only, so another device never receives a font it may not have.
   */
  setFont(key: FontPreferenceKey, family: string): void {
    if (isFontPreset(key, family)) {
      this.device.set(FONT_OVERRIDE_KEYS[key], null)
      this.personal.set(key, family)
      this.paintFont(key)
      return
    }
    this.device.set(FONT_OVERRIDE_KEYS[key], family)
    this.paintFont(key)
  }

  /** "Use synced font": drop this device's installed-font override. */
  useSyncedFont(key: FontPreferenceKey): void {
    this.device.set(FONT_OVERRIDE_KEYS[key], null)
    this.paintFont(key)
  }

  /** The synced preset under a font key, whatever this device paints. */
  syncedFontOf(key: FontPreferenceKey): string {
    return this.personal.values[key]
  }

  fontOverrideOf(key: FontPreferenceKey): string | null {
    return this.device.values[FONT_OVERRIDE_KEYS[key]]
  }

  /**
   * This client's analytics consent. It never reaches a host: the host emitter
   * has its own consent in Host settings, so one switch cannot change both.
   */
  setClientAnalyticsEnabled(enabled: boolean): void {
    this.device.set('clientAnalyticsEnabled', enabled)
    setAnalyticsEnabled(enabled)
  }

  setNotificationChannel(channel: NotificationChannel, enabled: boolean): void {
    this.setNotifications((next) => { next.channels[channel] = enabled })
  }

  setNotificationEvent(event: NotificationEvent, enabled: boolean): void {
    this.setNotifications((next) => { next.events[event] = enabled })
  }

  private setNotifications(change: (next: NotificationPreferences) => void): void {
    const next = $state.snapshot(this.personal.values.notifications)
    change(next)
    for (const channel of NOTIFICATION_CHANNELS) next.channels[channel] = next.channels[channel] === true
    for (const event of NOTIFICATION_EVENTS) next.events[event] = next.events[event] === true
    this.personal.setNotifications(next)
  }

  zoomIn(): void {
    this.setZoomFactor(stepZoomFactor(this.device.layout.zoomFactor, 1))
  }

  zoomOut(): void {
    this.setZoomFactor(stepZoomFactor(this.device.layout.zoomFactor, -1))
  }

  resetZoom(): void {
    this.setZoomFactor(ZOOM_FACTOR_DEFAULT)
  }

  setZoomFactor(factor: number): void {
    this.setLayout('zoomFactor', factor)
  }

  // OS-supplied system theme; not persisted.
  setSystemTheme(isDark: boolean): void {
    this._systemIsDark = isDark
    if (this.personal.values.themeMode === 'system') applyTheme(isDark)
  }

  // ── Painting ──

  private fontFamilyOf(key: FontPreferenceKey): string {
    return effectiveFontFamily(key, this.personal.values, this.device.values).family
  }

  private paintFont(key: FontPreferenceKey): void {
    FONT_DISPLAY[key](this.fontFamilyOf(key))
  }

  private paintSize(key: PaintedSizeKey): void {
    const paint: (value: number) => void = PERSONAL_DISPLAY[key]
    paint(this.personal.values[key])
  }

  /** Repaints only what a personal change touched, so a sync of one key costs one style write. */
  private repaint(change: PersonalChange): void {
    const keys = [...Object.keys(change.set), ...change.reset]
    for (const key of keys) {
      if (key === 'themeMode') applyTheme(this.isDark)
      const fontKey = FONT_PREFERENCE_KEYS.find((candidate) => candidate === key)
      if (fontKey) this.paintFont(fontKey)
      if (isPaintedSizeKey(key)) this.paintSize(key)
    }
  }
}

export const spacing = {
  contentWidth: 960,
  containerRadius: 20,
  containerPadding: 12,
  tabHeight: 32,
  inputMinHeight: 44,
  inputMaxHeight: 160,
  conversationMaxHeight: 380,
  pillRadius: 9999,
  circleSize: 36,
  circleGap: 8,
} as const

export const [getSettingsContext, setSettingsContext] = createAppContext<SettingsContext>('settings')
