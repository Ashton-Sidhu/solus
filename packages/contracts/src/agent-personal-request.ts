import { z } from 'zod'
import { agentProfileEntrySchema, agentProfileKeySchema, agentProfileSchema, AGENT_PROFILE_MAX_ENTRIES, type AgentProfileKey } from './agent-profile'
import { seatProviderSchema } from './seats'
import { FONT_FAMILY_PREFERENCE_MAX_LENGTH, personalSettingsDocumentSchema } from './settings'
import { EDITOR_IDS, TERMINAL_APP_IDS } from './types'
import { ZOOM_FACTOR_MAX, ZOOM_FACTOR_MIN } from './zoom'

/**
 * An agent runs on a host, and only the person's clients hold their settings and
 * agent profile. So the host asks a client of that person to read or change them,
 * on the socket (a host→client request answered on its ack). The client applies
 * a change as a local edit, and its sync sends it on like any other
 * (docs/settings.md).
 */
export const AGENT_PERSONAL_REQUEST = 'personal.agentRequest'

const profileKeySchema = z.custom<AgentProfileKey>((value) => agentProfileKeySchema.safeParse(value).success, 'Not an agent profile key.')

/** A change to the profile, as the client applies it: entries to set by key, and keys to remove. */
export const agentProfileWriteSchema = z.object({
  set: agentProfileSchema,
  reset: z.array(profileKeySchema).max(AGENT_PROFILE_MAX_ENTRIES).default([]),
}).strict()
export type AgentProfileWrite = z.output<typeof agentProfileWriteSchema>

const fontOverrideSchema = z.string().trim().min(1).max(FONT_FAMILY_PREFERENCE_MAX_LENGTH).nullable()

/** A key combination, as Settings → Keybindings records it. */
const keyComboSchema = z.object({
  code: z.string().min(1).max(40),
  alt: z.boolean().optional(),
  shift: z.boolean().optional(),
  meta: z.boolean().optional(),
  ctrl: z.boolean().optional(),
  mod: z.boolean().optional(),
}).strict()

/**
 * The settings of one client device that an agent may read and change: the
 * device's own choices, never its layout or what it showed (panels, the last
 * project, onboarding). They never sync. Strict, unlike the stored copy, which
 * heals: a wrong value from an agent is refused, not quietly replaced.
 */
export const agentDeviceSettingsSchema = z.object({
  voiceModeEnabled: z.boolean().describe('When on, the composer starts to listen when it is empty, focused, and visible.'),
  autoSendVoiceTranscripts: z.boolean(),
  vadSilenceMs: z.number().int().min(1000).max(8000).describe('The silence that ends a voice prompt, in milliseconds.'),
  defaultEditor: z.enum(EDITOR_IDS).nullable(),
  fallbackTerminal: z.enum(TERMINAL_APP_IDS).nullable().describe('The terminal app for Open in terminal, worktree terminals, and editors that run in a terminal.'),
  fontSmoothing: z.boolean(),
  clientAnalyticsEnabled: z.boolean().nullable().describe('When on, this client sends its own analytics. Null: the person did not choose yet, which counts as off.'),
  fontFamilyOverride: fontOverrideSchema.describe('An installed font family for the interface on this device. Null uses the synced preset (personal fontFamily).'),
  codeFontFamilyOverride: fontOverrideSchema.describe('An installed font family for code on this device. Null uses the synced preset (personal codeFontFamily).'),
  documentFontFamilyOverride: fontOverrideSchema.describe('An installed font family for documents on this device. Null uses the synced preset (personal documentFontFamily).'),
  promptFontFamilyOverride: fontOverrideSchema.describe('An installed font family for the prompt on this device. Null uses the synced preset (personal promptFontFamily).'),
  zoomFactor: z.number().min(ZOOM_FACTOR_MIN).max(ZOOM_FACTOR_MAX),
  keybindings: z.record(z.string().min(1).max(100), keyComboSchema.nullable()).refine((bindings) => Object.keys(bindings).length <= 500).describe('Shortcut overrides by binding id. The map replaces the current overrides. Null removes the shortcut of a binding. A binding not named uses its default shortcut.'),
}).strict()
export type AgentDeviceSettings = z.output<typeof agentDeviceSettingsSchema>

/** Consent is set, never returned to undecided: only the person leaves it undecided. */
export const agentDeviceSettingsPatchSchema = agentDeviceSettingsSchema.extend({ clientAnalyticsEnabled: z.boolean() }).partial()
export type AgentDeviceSettingsPatch = z.output<typeof agentDeviceSettingsPatchSchema>

/** A request with no part reads the settings, the profile, and the device. */
export const agentPersonalRequestSchema = z.object({
  settings: personalSettingsDocumentSchema.optional(),
  profile: agentProfileWriteSchema.optional(),
  device: agentDeviceSettingsPatchSchema.optional(),
}).strict()
export type AgentPersonalRequest = z.output<typeof agentPersonalRequestSchema>

const [, skillEntrySchema, integrationEntrySchema] = agentProfileEntrySchema.options

/**
 * The profile as an agent reads it: a file by its path, size, and hash, never its
 * content, which can total megabytes. Skills and MCP servers are whole; the
 * profile holds no key or token.
 */
export const agentProfileSummarySchema = z.array(z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('file'),
    provider: seatProviderSchema,
    path: z.string(),
    bytes: z.number().int().nonnegative(),
    hash: z.string(),
    executable: z.boolean().optional(),
  }).strict(),
  skillEntrySchema,
  integrationEntrySchema,
])).max(AGENT_PROFILE_MAX_ENTRIES)
export type AgentProfileSummary = z.output<typeof agentProfileSummarySchema>

/**
 * The person's settings, defaults filled in, their profile, and the answering
 * client's device settings after the request, or why the client refused. A
 * client that keeps no device settings (the phone app) answers null.
 */
export const agentPersonalReplySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), settings: personalSettingsDocumentSchema, profile: agentProfileSummarySchema, device: agentDeviceSettingsSchema.nullable() }),
  z.object({ ok: z.literal(false), error: z.string().max(500) }),
])
export type AgentPersonalReply = z.output<typeof agentPersonalReplySchema>
