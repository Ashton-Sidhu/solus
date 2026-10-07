/**
 * The person's settings on this client (plans/018 §3.5, §5): one validated local
 * profile per account and cloud origin, and a separate anonymous profile while
 * signed out. It is the source of truth on this client; the account document is
 * its optional replica, moved by `SettingsSync`. Nothing here talks to a host.
 *
 * Every write names one key and passes that key's strict personal schema, so a
 * value the account would refuse never enters the profile. An organization rule
 * never enters it either: rules are overlays resolved for display and checked by
 * the host, and the profile keeps the person's own choice under them.
 */

import {
  DEFAULT_PERSONAL_SETTINGS,
  addShowMeLens,
  EXECUTION_PREFERENCE_KEYS,
  MAX_SIDEBAR_MOTION_MS,
  MIN_ASSISTANT_TEXT_OPACITY,
  PERSONAL_SETTING_KEYS,
  PERSONAL_SETTING_SCHEMAS,
  type ExecutionPreferences,
  type PersonalSettingKey,
  type PersonalSettings,
  type PersonalSettingsDocument,
} from '@solus/contracts/settings'
import type { NotificationPreferences } from '@solus/contracts/notification-types'
import { z } from 'zod'
import { storedJson } from './device-settings.store.svelte'

// The boot scripts in the client and desktop `index.html` read these keys to paint the theme before load.
const PROFILE_PREFIX = 'solus.personal-settings.v1:'
/** The account key of the profile last shown, so a boot paints it before the account answers. */
const ACTIVE_PROFILE_KEY = 'solus.personal-settings.active'
export const ANONYMOUS_PROFILE = 'anonymous'

export const personalProfileStorageKey = (accountKey: string): string => `${PROFILE_PREFIX}${accountKey}`

/** A personal change: keys set, and keys returned to their default. */
export interface PersonalChange {
  set: PersonalSettingsDocument
  reset: PersonalSettingKey[]
}

/** `local`: the person changed it here. `remote`: sync applied it. `profile`: another account's profile, or another tab. */
export type PersonalChangeOrigin = 'local' | 'remote' | 'profile'

/** Bounds a slider or a typed number takes on the way in, before the strict schema checks it. */
const NUMBER_BOUNDS = new Map<PersonalSettingKey, { min: number; max: number; whole: ((value: number) => number) | null }>([
  ['fontSize', { min: 8, max: 32, whole: null }],
  ['codeFontSize', { min: 8, max: 32, whole: null }],
  ['documentFontSize', { min: 12, max: 40, whole: null }],
  ['promptFontSize', { min: 8, max: 32, whole: null }],
  ['sidebarCompletedRetentionDays', { min: 1, max: 365, whole: Math.floor }],
  ['sidebarMotionMs', { min: 0, max: MAX_SIDEBAR_MOTION_MS, whole: Math.round }],
  ['assistantTextOpacity', { min: MIN_ASSISTANT_TEXT_OPACITY, max: 100, whole: Math.round }],
])

/** One key through its strict schema; undefined when the value does not pass. */
function parseKey<K extends PersonalSettingKey>(key: K, value: PersonalSettings[K] | PersonalSettingsDocument[K] | number): PersonalSettings[K] | undefined {
  const parsed = PERSONAL_SETTING_SCHEMAS[key].safeParse(value)
  // SAFETY: each personal schema outputs that key's own `PersonalSettings` type.
  return parsed.success ? (parsed.data as PersonalSettings[K]) : undefined
}

/** A person's value, bounded where a control can overshoot, then held to its strict schema. */
function normalized<K extends PersonalSettingKey>(key: K, value: PersonalSettings[K]): PersonalSettings[K] | undefined {
  const bounds = NUMBER_BOUNDS.get(key)
  const number = z.number().safeParse(value)
  if (!bounds || !number.success) return parseKey(key, value)
  const whole = bounds.whole ? bounds.whole(number.data) : number.data
  return parseKey(key, Math.max(bounds.min, Math.min(bounds.max, whole)))
}

/** A stored profile, key by key: one bad value costs only that key, which then reads as its default. */
const storedProfileSchema = storedJson(z.looseObject({}).transform((stored) => {
  const document: PersonalSettingsDocument = {}
  for (const key of PERSONAL_SETTING_KEYS) {
    const parsed = PERSONAL_SETTING_SCHEMAS[key].safeParse(stored[key])
    if (parsed.success) Object.assign(document, { [key]: parsed.data })
  }
  return document
}))

type SettingValue = PersonalSettings[PersonalSettingKey] | undefined

function sameValue(left: SettingValue, right: SettingValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export class PersonalSettingsStore {
  /** Every key, document over defaults. Mutated one key at a time. */
  values = $state<PersonalSettings>(structuredClone(DEFAULT_PERSONAL_SETTINGS))
  /** The profile on screen: `origin|userId`, or `anonymous`. */
  accountKey = $state(ANONYMOUS_PROFILE)
  /** The keys the person set; an absent key reads as its default. Plain, not reactive. */
  private document: PersonalSettingsDocument = {}
  private readonly listeners = new Set<(change: PersonalChange, origin: PersonalChangeOrigin) => void>()

  constructor(private readonly storage: Storage = localStorage) {
    const remembered = storage.getItem(ACTIVE_PROFILE_KEY)
    const activeDocument = remembered ? this.readProfile(remembered) : null
    const active = activeDocument ? remembered ?? ANONYMOUS_PROFILE : ANONYMOUS_PROFILE
    const document = activeDocument ?? this.readProfile(ANONYMOUS_PROFILE) ?? {}
    this.accountKey = active
    this.document = document
    this.values = structuredClone({ ...DEFAULT_PERSONAL_SETTINGS, ...document })
    globalThis.window?.addEventListener?.('storage', (event: StorageEvent) => {
      if (event.key === personalProfileStorageKey(this.accountKey)) this.adoptDocument(this.readProfile(this.accountKey) ?? {}, 'profile')
    })
  }

  /** What the person stored, as a plain document: the seed a first sync offers. */
  get storedDocument(): PersonalSettingsDocument {
    return structuredClone(this.document)
  }

  /** The preferences a host reads while it runs this person's work (plans/018 §6). Plain, so it crosses IPC. */
  get executionPreferences(): ExecutionPreferences {
    const preferences: ExecutionPreferences = {}
    for (const key of EXECUTION_PREFERENCE_KEYS) Object.assign(preferences, { [key]: $state.snapshot(this.values[key]) })
    return preferences
  }

  onChange(listener: (change: PersonalChange, origin: PersonalChangeOrigin) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * The person changed one key here. Returns false when the value does not pass
   * the key's schema; nothing is stored then. An equal value changes nothing.
   */
  set<K extends PersonalSettingKey>(key: K, value: PersonalSettings[K]): boolean {
    const parsed = normalized(key, value)
    if (parsed === undefined) return false
    if (Object.hasOwn(this.document, key) && sameValue(this.document[key], parsed)) return true
    this.write(key, parsed)
    this.persist()
    this.emit({ set: { [key]: structuredClone(parsed) }, reset: [] }, 'local')
    return true
  }

  setNotifications(next: NotificationPreferences): boolean {
    return this.set('notifications', next)
  }

  /** Cloud changes sync confirmed. Never an echo of this client's own edit. */
  applyRemote(change: PersonalChange): void {
    const applied: PersonalChange = { set: {}, reset: [] }
    for (const key of PERSONAL_SETTING_KEYS) {
      if (!Object.hasOwn(change.set, key)) continue
      const value = parseKey(key, change.set[key])
      if (value === undefined) continue
      this.write(key, value)
      Object.assign(applied.set, { [key]: value })
    }
    for (const key of change.reset) {
      this.clear(key)
      applied.reset.push(key)
    }
    this.persist()
    this.emit(applied, 'remote')
  }

  /**
   * Shows the profile of another account (null: signed out). A first sign-in
   * starts from a copy of the anonymous profile; an account's profile is never
   * copied into the anonymous one.
   */
  setAccount(accountKey: string | null): void {
    const next = accountKey ?? ANONYMOUS_PROFILE
    if (next === this.accountKey) return
    let document = this.readProfile(next)
    if (!document) {
      document = this.readProfile(ANONYMOUS_PROFILE) ?? {}
      this.writeProfile(next, document)
    }
    this.accountKey = next
    try { this.storage.setItem(ACTIVE_PROFILE_KEY, next) } catch {}
    this.adoptDocument(document, 'profile')
  }

  /** Sign-out: this account's local profile leaves this client. */
  removeProfile(accountKey: string): void {
    if (accountKey === ANONYMOUS_PROFILE) return
    if (accountKey === this.accountKey) this.setAccount(null)
    try { this.storage.removeItem(personalProfileStorageKey(accountKey)) } catch {}
  }

  /** Replaces the whole profile, per key, so only changed keys wake their readers. */
  private adoptDocument(document: PersonalSettingsDocument, origin: PersonalChangeOrigin): void {
    const change: PersonalChange = { set: {}, reset: [] }
    for (const key of PERSONAL_SETTING_KEYS) {
      const stored = Object.hasOwn(document, key) ? parseKey(key, document[key]) : undefined
      if (stored !== undefined) {
        if (sameValue(this.values[key], stored)) Object.assign(this.document, { [key]: structuredClone(stored) })
        else {
          this.write(key, stored)
          Object.assign(change.set, { [key]: stored })
        }
        continue
      }
      if (sameValue(this.values[key], DEFAULT_PERSONAL_SETTINGS[key])) delete this.document[key]
      else {
        this.clear(key)
        change.reset.push(key)
      }
    }
    this.emit(change, origin)
  }

  private write<K extends PersonalSettingKey>(key: K, value: PersonalSettings[K]): void {
    Object.assign(this.document, { [key]: structuredClone(value) })
    this.values[key] = structuredClone(value)
  }

  private clear(key: PersonalSettingKey): void {
    delete this.document[key]
    Object.assign(this.values, { [key]: structuredClone(DEFAULT_PERSONAL_SETTINGS[key]) })
  }

  private emit(change: PersonalChange, origin: PersonalChangeOrigin): void {
    if (Object.keys(change.set).length === 0 && change.reset.length === 0) return
    for (const listener of this.listeners) listener(change, origin)
  }

  private readProfile(accountKey: string): PersonalSettingsDocument | null {
    const migrationKey = `${personalProfileStorageKey(accountKey)}:show-me.v1`
    const stored = this.storage.getItem(personalProfileStorageKey(accountKey))
    if (stored === null) {
      try { this.storage.setItem(migrationKey, 'done') } catch {}
      return null
    }
    const parsed = storedProfileSchema.safeParse(stored)
    const document = parsed.success ? parsed.data : {}
    if (this.storage.getItem(migrationKey) === 'done') return document
    const migrated = addShowMeLens(document)
    try {
      if (migrated !== document) this.storage.setItem(personalProfileStorageKey(accountKey), JSON.stringify(migrated))
      this.storage.setItem(migrationKey, 'done')
    } catch {}
    return migrated
  }

  private writeProfile(accountKey: string, document: PersonalSettingsDocument): void {
    try {
      this.storage.setItem(personalProfileStorageKey(accountKey), JSON.stringify(document))
    } catch {}
  }

  private persist(): void {
    this.writeProfile(this.accountKey, this.document)
  }
}
