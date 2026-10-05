// ─── Host config ───
//
// What a host owns about itself and serves to the clients that administer it:
// which Solus tools its agents may use, where it exports telemetry, how long it
// keeps archived automations, whether it continues sessions after a restart,
// which projects warm review guides, and whether its own analytics emitter runs.
//
// A person's choices are not here. They are personal settings
// (`settings.ts`): a profile on each client, synced to the account when the
// person turns sync on, and sent to a host with the work that needs them
// (plans/018). Device choices stay on the device.

import { z } from 'zod'
import { CONFIGURABLE_SOLUS_TOOL_NAMES, withoutRetiredSolusTools, type SolusToolPreferences } from './agent-tools'
import type { OtelSettings } from './types'

export interface HostConfig {
  solusTools: SolusToolPreferences
  /** Restart continuation policy; managed cloud hosts always disable it. */
  continueSessionsAfterHostRestart: boolean
  /**
   * Keyed by project path on this host. The same map on another machine would
   * name directories that do not exist there.
   */
  reviewWarmingByProject: Record<string, boolean>
  archivedAutomationRetentionDays: number
  /** Where this host sends its own telemetry. `headers` carries collector credentials. */
  otel: OtelSettings
  /** This host's analytics emitter. A client's own emitter is a device setting. */
  analyticsEnabled: boolean
}

export const DEFAULT_OTEL_SETTINGS: OtelSettings = {
  enabled: false,
  endpoint: '',
  headers: '',
  exportMetrics: true,
  exportTraces: true,
}

/**
 * The nested key arrives as a partial — the Telemetry panel toggles one switch
 * at a time — so this only checks shape. Normalization happens in
 * `mergeHostConfig`, after the patch is merged onto the current value.
 */
const otelPatchSchema = z.object({
  enabled: z.boolean().optional(),
  endpoint: z.string().optional(),
  headers: z.string().optional(),
  exportMetrics: z.boolean().optional(),
  exportTraces: z.boolean().optional(),
}).strict()

/** Enabling with no endpoint would be a switch that reports "on" while
 *  exporting nowhere, so the endpoint is part of being enabled. The endpoint is
 *  stripped of the trailing slash that would otherwise produce `host//v1/traces`. */
export function normalizeOtelSettings(otel: Partial<OtelSettings> | undefined): OtelSettings {
  if (!otel) return { ...DEFAULT_OTEL_SETTINGS }
  const endpoint = (otel.endpoint ?? '').trim().replace(/\/+$/, '')
  return {
    enabled: otel.enabled === true && endpoint.length > 0,
    endpoint,
    headers: (otel.headers ?? '').trim(),
    exportMetrics: otel.exportMetrics !== false,
    exportTraces: otel.exportTraces !== false,
  }
}

/**
 * One row per key: how a patch value validates, what the key is before anyone
 * sets it, and whether an agent may write it. A stored file heals one bad key to
 * its default (`.catch`) rather than losing the whole config; a key where a wrong
 * value is worse than a refused one (`solusTools`, retention) does not heal.
 *
 * Only `continueSessionsAfterHostRestart` is open to agents. The others configure
 * the machine's security, data retention, or consent, and `otel` is never sent to
 * an agent at all.
 */
interface HostConfigField<Value, Patch> {
  patch: z.ZodType<Patch, unknown>
  default: Value
  agentWritable: boolean
}

type HostConfigFieldTable = { [K in keyof HostConfig]: HostConfigField<HostConfig[K], unknown> }

function field<const Value, Patch>(
  patch: z.ZodType<Patch, unknown>,
  defaultValue: Value,
  agentWritable: boolean,
): HostConfigField<Value, Patch> {
  return { patch, default: defaultValue, agentWritable }
}

export const HOST_CONFIG_FIELDS = {
  solusTools: field(z.record(z.string(), z.boolean()).transform(withoutRetiredSolusTools).pipe(z.partialRecord(z.enum(CONFIGURABLE_SOLUS_TOOL_NAMES), z.boolean())), {}, false),
  continueSessionsAfterHostRestart: field(z.boolean().catch(true), true, true),
  reviewWarmingByProject: field(z.record(z.string(), z.boolean()).catch({}), {}, false),
  archivedAutomationRetentionDays: field(z.number().int().min(1).max(3650), 30, false),
  otel: field(otelPatchSchema.catch({}), DEFAULT_OTEL_SETTINGS, false),
  analyticsEnabled: field(z.boolean().catch(true), true, false),
} satisfies HostConfigFieldTable

export type HostConfigKey = keyof typeof HOST_CONFIG_FIELDS

export function isHostConfigKey(key: string): key is HostConfigKey {
  return Object.hasOwn(HOST_CONFIG_FIELDS, key)
}

export const HOST_CONFIG_KEYS: readonly HostConfigKey[] = Object.keys(HOST_CONFIG_FIELDS).filter(isHostConfigKey)

type HostConfigColumn<Column extends keyof HostConfigField<unknown, unknown>> = {
  [K in HostConfigKey]: (typeof HOST_CONFIG_FIELDS)[K][Column]
}

/** One column of the table, read out as an object keyed like the table. */
function column<Column extends keyof HostConfigField<unknown, unknown>>(name: Column): HostConfigColumn<Column> {
  // SAFETY: every `HostConfigKey` contributes one entry, so the result has exactly the table's keys.
  return Object.fromEntries(HOST_CONFIG_KEYS.map((key) => [key, HOST_CONFIG_FIELDS[key][name]])) as HostConfigColumn<Column>
}

/** Unknown keys are refused: a person's or a device's key has no place on a host. */
export const hostConfigPatchSchema = z.object(column('patch')).partial().strict()

export type HostConfigPatch = z.infer<typeof hostConfigPatchSchema>

export const DEFAULT_HOST_CONFIG: HostConfig = column('default')

export const HOST_CONFIG_AGENT_WRITABLE: Record<HostConfigKey, boolean> = column('agentWritable')

/**
 * Never sent to an agent in any form. `otel.headers` carries the credentials
 * for the operator's collector, so the whole key is withheld.
 */
export const HOST_CONFIG_AGENT_HIDDEN_KEYS: readonly HostConfigKey[] = ['otel']

const AGENT_WRITABLE_KEYS: ReadonlySet<string> = new Set(
  Object.entries(HOST_CONFIG_AGENT_WRITABLE)
    .filter(([, writable]) => writable)
    .map(([key]) => key),
)

export function isAgentWritableHostConfigKey(key: string): key is HostConfigKey {
  return AGENT_WRITABLE_KEYS.has(key)
}

/** The writable keys, for a tool that has to tell an agent what it may set. */
export const AGENT_WRITABLE_HOST_CONFIG_KEYS: readonly string[] = [...AGENT_WRITABLE_KEYS].sort()

export interface TypeSafeKeyStatus {
  source: 'saved' | 'environment' | null
}

export interface HostConfigSnapshot {
  /** Contains no credential value. */
  typeSafe: TypeSafeKeyStatus
  config: HostConfig
}

/** Applies a validated patch. Only keys the patch actually carries change. */
export function mergeHostConfig(base: HostConfig, patch: HostConfigPatch): HostConfig {
  const next = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) Object.assign(next, { [key]: value })
  }
  // The nested keys merge onto the current value rather than replacing it: a
  // panel that toggles one switch sends one field.
  if (patch.otel) next.otel = normalizeOtelSettings({ ...base.otel, ...patch.otel })
  if (patch.solusTools) next.solusTools = { ...base.solusTools, ...patch.solusTools }
  return next
}
