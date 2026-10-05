/**
 * What stays with this client install or browser profile (plans/018 §3.1, §3.2):
 * the device settings of the contract (microphone, launch targets, installed-font
 * overrides, client analytics consent) and the client's own layout and
 * navigation keys. Nothing here enters personal sync or reaches a host.
 */

import { z } from 'zod'
import {
  DEFAULT_DEVICE_SETTINGS,
  deviceSettingsSchema,
  type DeviceSettings,
} from '@solus/contracts/settings'
import { clampZoomFactor, ZOOM_FACTOR_DEFAULT } from '@solus/contracts/zoom'
import type { BindingOverrides } from '../../lib/keybindings/editing'
import { KEYBINDINGS } from '../../lib/keybindings/manifest'

const DEVICE_SETTINGS_KEY = 'solus.device-settings.v1'
/** The layout keys. Every renderer of this origin reads it, so a zoom change reaches them all. */
export const DEVICE_LAYOUT_KEY = 'solus.device-layout.v1'

export type ProjectPanelSectionId = 'goal' | 'environment' | 'git' | 'linked' | 'subagents' | 'watches'
const DEFAULT_PROJECT_PANEL_COLLAPSED = {
  // The section only exists while a goal is set, so it opens on arrival — a
  // collapsed default would hide the thing the user just asked to see.
  goal: false,
  environment: false,
  git: false,
  // The section only exists while the session links a pull request, and the
  // links are the reason to read it — so it opens.
  linked: false,
  // The section only exists once the session has dispatched a sub-agent, and
  // a live fan-out is the thing the reader wants to watch — so it opens.
  subagents: false,
  // The section only exists while the session has an active watch, which is a
  // wait the person may want to stop — so it opens.
  watches: false,
} as const satisfies Record<ProjectPanelSectionId, boolean>

/**
 * Drop unknown binding ids and malformed combos so a stale or hand-edited
 * localStorage blob can't break the dispatcher. Each value must be a combo with
 * a string `code`; the modifier flags, if present, must be booleans.
 */
const keyComboSchema = z.object({
  code: z.string().min(1),
  alt: z.boolean().optional(),
  shift: z.boolean().optional(),
  meta: z.boolean().optional(),
  ctrl: z.boolean().optional(),
  mod: z.boolean().optional(),
})

// `null` is a shortcut the user removed.
const keybindingsSchema = z.record(z.string(), keyComboSchema.nullable()).transform((bindings) => {
  const valid: BindingOverrides = {}
  for (const [id, combo] of Object.entries(bindings)) {
    if (id in KEYBINDINGS) valid[id] = combo
  }
  return valid
})

const projectPanelCollapsedSchema = z.object({
  goal: z.boolean().optional(),
  environment: z.boolean().optional(),
  git: z.boolean().optional(),
  linked: z.boolean().optional(),
  subagents: z.boolean().optional(),
  watches: z.boolean().optional(),
}).transform((collapsed) => ({ ...DEFAULT_PROJECT_PANEL_COLLAPSED, ...collapsed }))

const projectLocationSchema = z.object({
  serverId: z.string().min(1),
  directory: z.string().min(1),
})

/** A project directory on one host. A path names a folder on one machine only. */
export type ProjectLocation = z.infer<typeof projectLocationSchema>

interface LayoutField<Value> {
  /** Heals a stored value; a bad one falls back rather than failing the layout. */
  schema: z.ZodType<Value, unknown>
  /** A fresh install, and a key the stored layout does not hold. */
  default: Value
}

function layoutField<Value>(schema: z.ZodType<Value, unknown>, defaultValue: Value): LayoutField<Value> {
  return { schema, default: defaultValue }
}

const DEVICE_LAYOUT_FIELDS = {
  zoomFactor: layoutField(z.number().transform(clampZoomFactor).catch(ZOOM_FACTOR_DEFAULT), ZOOM_FACTOR_DEFAULT),
  // Settings → Appearance shows the per-surface font overrides (prompt,
  // document, smoothing) only when this is on; the two-font view is the
  // default. It is how this client's settings page is folded.
  typographyAdvanced: layoutField(z.boolean().catch(false), false),
  keybindings: layoutField<BindingOverrides>(keybindingsSchema.catch({}), {}),
  projectPanelOpen: layoutField(z.boolean().catch(false), false),
  splitProjectPanelOpen: layoutField(z.boolean().catch(false), false),
  projectPanelWidth: layoutField<number | null>(z.number().positive().nullable().catch(null), null),
  splitProjectPanelWidth: layoutField<number | null>(z.number().positive().nullable().catch(null), null),
  projectPanelCollapsed: layoutField<Record<ProjectPanelSectionId, boolean>>(
    projectPanelCollapsedSchema.catch(DEFAULT_PROJECT_PANEL_COLLAPSED),
    DEFAULT_PROJECT_PANEL_COLLAPSED,
  ),
  splitProjectPanelCollapsed: layoutField<Record<ProjectPanelSectionId, boolean>>(
    projectPanelCollapsedSchema.catch(DEFAULT_PROJECT_PANEL_COLLAPSED),
    DEFAULT_PROJECT_PANEL_COLLAPSED,
  ),
  // The project the task list is scoped to, by `projectKey`. Null is the whole
  // list — the sidebar is flat across every open project either way, so this
  // narrows what is in it rather than changing its shape.
  sidebarProjectFilter: layoutField<string | null>(z.string().nullable().catch(null), null),
  // The project the last session started in, and the host that holds it. A
  // server id only means something to the client that registered it.
  lastProject: layoutField<ProjectLocation | null>(projectLocationSchema.nullable().catch(null), null),
  // First-run onboarding has already been through, or skipped.
  onboardingCompleted: layoutField(z.boolean().catch(false), false),
}

export type DeviceLayoutKey = keyof typeof DEVICE_LAYOUT_FIELDS
export type DeviceLayout = { [K in DeviceLayoutKey]: (typeof DEVICE_LAYOUT_FIELDS)[K]['default'] }
/** The layout keys, in table order. Held equal to `CLIENT_DEVICE_LAYOUT_KEYS` by test. */
export const DEVICE_LAYOUT_KEYS: readonly DeviceLayoutKey[] = Object.keys(DEVICE_LAYOUT_FIELDS).filter(
  (key): key is DeviceLayoutKey => Object.hasOwn(DEVICE_LAYOUT_FIELDS, key),
)
export const DEVICE_SETTING_KEYS = Object.keys(DEFAULT_DEVICE_SETTINGS).filter(
  (key): key is keyof DeviceSettings => Object.hasOwn(DEFAULT_DEVICE_SETTINGS, key),
)

/** Stored JSON text, parsed at the storage boundary. Malformed text reads as nothing stored. */
export function storedJson<Schema extends z.ZodType>(schema: Schema) {
  return z.string().transform((text, context) => {
    try {
      return JSON.parse(text)
    } catch {
      context.addIssue({ code: 'custom', message: 'not JSON' })
      return z.NEVER
    }
  }).pipe(schema)
}

const storedDeviceSettingsSchema = storedJson(z.looseObject({}).transform((stored) => deviceSettingsSchema.parse({ ...DEFAULT_DEVICE_SETTINGS, ...stored })))

/** Each stored key reads through its own field schema, which heals a bad value; an absent key reads as its default. */
const storedLayoutSchema = storedJson(z.looseObject({}).transform((stored) => {
  const entries = DEVICE_LAYOUT_KEYS.map((key) => {
    const field = DEVICE_LAYOUT_FIELDS[key]
    return [key, stored[key] === undefined ? structuredClone(field.default) : field.schema.parse(stored[key])]
  })
  // SAFETY: every layout key contributes one entry that passed its own field schema.
  return Object.fromEntries(entries) as DeviceLayout
}))

function defaultLayout(): DeviceLayout {
  // SAFETY: every layout key contributes its own default.
  return structuredClone(Object.fromEntries(DEVICE_LAYOUT_KEYS.map((key) => [key, DEVICE_LAYOUT_FIELDS[key].default])) as DeviceLayout)
}

export class DeviceSettingsStore {
  values = $state<DeviceSettings>(structuredClone(DEFAULT_DEVICE_SETTINGS))
  layout = $state<DeviceLayout>(defaultLayout())

  constructor(private readonly storage: Storage = localStorage) {
    // Nothing stored, or text that is not JSON, reads as a fresh install.
    const layout = storedLayoutSchema.safeParse(storage.getItem(DEVICE_LAYOUT_KEY))
    if (layout.success) this.layout = layout.data
    const stored = storedDeviceSettingsSchema.safeParse(storage.getItem(DEVICE_SETTINGS_KEY))
    if (stored.success) this.values = stored.data
  }

  /** One device key. Stored values heal through the device schema, so a bad value falls back on its own. */
  set<K extends keyof DeviceSettings>(key: K, value: DeviceSettings[K]): void {
    // Parsed whole, so the key heals through its own field of the device schema.
    this.values[key] = deviceSettingsSchema.parse({ ...$state.snapshot(this.values), [key]: value })[key]
    this.save()
  }

  setLayout<K extends DeviceLayoutKey>(key: K, value: DeviceLayout[K]): void {
    this.layout[key] = value
    if (key === 'zoomFactor') this.layout.zoomFactor = clampZoomFactor(this.layout.zoomFactor)
    try {
      this.storage.setItem(DEVICE_LAYOUT_KEY, JSON.stringify($state.snapshot(this.layout)))
    } catch {}
  }

  private save(): void {
    try {
      this.storage.setItem(DEVICE_SETTINGS_KEY, JSON.stringify($state.snapshot(this.values)))
    } catch {}
  }
}
