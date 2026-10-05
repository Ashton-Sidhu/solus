import { z } from 'zod'
import {
  EXECUTION_PREFERENCE_KEYS,
  PERSONAL_SETTING_KEYS,
  PERSONAL_SETTING_SCHEMAS,
  personalSettingsWithDefaults,
  type ExecutionPreferences,
  type ModelOptions,
  type PersonalSettingKey,
  type PersonalSettings,
  type PersonalSettingsDocument,
} from '@solus/contracts/settings'
import type { AgentId } from '@solus/contracts/types'
import { settingsAccountKey, type PersonalSettingsChange, type SyncAccount } from '@solus/client-core/settings-sync'
import { Listeners } from '../../lib/listeners'
import type { KeyValueStore } from '../../platform/ports'

/**
 * The person's own settings on this device (plans/018 §3.5, §5): one local
 * profile per account and cloud origin, and one for nobody signed in. It is the
 * source of truth here; the account document is its optional replica, kept by
 * `SettingsSync`. Theme, agent defaults, instructions, and notification choices
 * live here, never on a host.
 */

const profileKey = (accountKey: string) => `solus.mobile.personal.v1:${accountKey}`

/**
 * A stored document, key by key: a bad value costs only its key, which then
 * reads as the default. Unknown keys are dropped. This heals local storage; it
 * never heals a value into a different choice.
 */
function storedField(schema: z.ZodType<PersonalSettingsDocument[PersonalSettingKey], unknown>) {
  return schema.optional().catch(undefined)
}

// SAFETY: each entry kept by the transform passed its own key's schema in `PERSONAL_SETTING_SCHEMAS`.
const storedDocumentSchema = z.object(Object.fromEntries(PERSONAL_SETTING_KEYS.map((key) => [key, storedField(PERSONAL_SETTING_SCHEMAS[key])])))
  .catch({})
  .transform((document) => Object.fromEntries(Object.entries(document).filter(([, value]) => value !== undefined)) as PersonalSettingsDocument)

const profileSchema = z.object({
  settings: storedDocumentSchema,
})

const profileJsonSchema = z.string().transform((text, context) => {
  try {
    return JSON.parse(text)
  } catch {
    context.addIssue({ code: 'custom', message: 'not JSON' })
    return z.NEVER
  }
}).pipe(profileSchema)

interface Profile {
  settings: PersonalSettingsDocument
}

export type PersonalSetOutcome = 'saved' | 'invalid'

export class PersonalSettingsStore {
  readonly changes = new Listeners()
  private accountKey = settingsAccountKey(null)
  private profile: Profile
  private values: PersonalSettings
  private readonly localChangeListeners = new Set<(change: PersonalSettingsChange) => void>()

  constructor(private readonly storage: KeyValueStore) {
    this.profile = this.load(this.accountKey) ?? { settings: {} }
    this.values = personalSettingsWithDefaults(this.profile.settings)
  }

  // ── Reading ──

  /** The values with defaults filled in. The same object until a value changes. */
  current = (): PersonalSettings => this.values

  /** Only the keys the person set: what a sync seed carries. */
  document(): PersonalSettingsDocument {
    return structuredClone(this.profile.settings)
  }

  /**
   * What a host runs this person's work with (plans/018 §6). Every key carries
   * its value, defaults included, so the host can tell that a permission mode
   * equal to the person's default is a default and may resolve to a rule.
   */
  executionPreferences(): ExecutionPreferences {
    // SAFETY: each entry is one execution key with its own value from `PersonalSettings`.
    return Object.fromEntries(EXECUTION_PREFERENCE_KEYS.map((key) => [key, structuredClone(this.values[key])])) as ExecutionPreferences
  }

  /** A copy of what a new conversation starts from; the conversation may change its copy. */
  runSettings(): Pick<PersonalSettings, 'defaultPermissionMode' | 'defaultModels' | 'modelOptionsByProvider'> {
    const { defaultPermissionMode, defaultModels, modelOptionsByProvider } = this.values
    return structuredClone({ defaultPermissionMode, defaultModels, modelOptionsByProvider })
  }

  /** Hears every change the person makes here; never a change that came from the cloud. */
  onLocalChange(listener: (change: PersonalSettingsChange) => void): () => void {
    this.localChangeListeners.add(listener)
    return () => { this.localChangeListeners.delete(listener) }
  }

  // ── Account ──

  /**
   * Shows the profile of the account now signed in, or the anonymous one. A
   * first profile for an account starts as a copy of the anonymous one, so
   * signing in does not reset what the person chose here. Nothing is uploaded.
   */
  setAccount(account: SyncAccount | null): void {
    const accountKey = settingsAccountKey(account)
    if (accountKey === this.accountKey) return
    const anonymous = settingsAccountKey(null)
    const stored = this.load(accountKey)
    const profile = stored ?? { settings: account ? this.load(anonymous)?.settings ?? {} : {} }
    this.accountKey = accountKey
    this.profile = profile
    if (!stored) this.save()
    this.refresh()
  }

  // ── Writing ──

  /** A change the person made. Refused whole when one value fails its schema. */
  set(patch: PersonalSettingsDocument): PersonalSetOutcome {
    const set: PersonalSettingsDocument = {}
    for (const key of PERSONAL_SETTING_KEYS) {
      if (!Object.hasOwn(patch, key)) continue
      const parsed = PERSONAL_SETTING_SCHEMAS[key].safeParse(patch[key])
      if (!parsed.success) return 'invalid'
      Object.assign(set, { [key]: parsed.data })
    }
    if (Object.keys(set).length === 0) return 'saved'
    Object.assign(this.profile.settings, structuredClone(set))
    this.save()
    this.refresh()
    for (const listener of this.localChangeListeners) listener({ set, reset: [] })
    return 'saved'
  }

  /** Keeps the options last chosen for one model, beside the other models' options. */
  saveModelOptions(provider: AgentId, model: string, options: ModelOptions): PersonalSetOutcome {
    const next = structuredClone(this.values.modelOptionsByProvider)
    next[provider] = { ...next[provider], [model]: options }
    return this.set({ modelOptionsByProvider: next })
  }

  /** Returns keys to their defaults. */
  reset(keys: readonly PersonalSettingKey[]): void {
    const reset = keys.filter((key) => Object.hasOwn(this.profile.settings, key))
    if (reset.length === 0) return
    for (const key of reset) delete this.profile.settings[key]
    this.save()
    this.refresh()
    for (const listener of this.localChangeListeners) listener({ set: {}, reset })
  }

  /** A change confirmed by the cloud. Not reported back to sync. */
  applyRemote(change: PersonalSettingsChange): void {
    Object.assign(this.profile.settings, structuredClone(change.set))
    for (const key of change.reset) delete this.profile.settings[key]
    this.save()
    this.refresh()
  }

  // ── Internals ──

  private load(accountKey: string): Profile | null {
    const raw = this.storage.getItem(profileKey(accountKey))
    if (!raw) return null
    const parsed = profileJsonSchema.safeParse(raw)
    return parsed.success ? parsed.data : null
  }

  private save(): void {
    this.storage.setItem(profileKey(this.accountKey), JSON.stringify(this.profile))
  }

  private refresh(): void {
    this.values = personalSettingsWithDefaults(this.profile.settings)
    this.changes.notify()
  }
}
