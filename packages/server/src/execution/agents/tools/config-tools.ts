import { createHash } from 'node:crypto'
import { z } from 'zod'
import { HOST_CONFIG_AGENT_HIDDEN_KEYS, HOST_CONFIG_KEYS, agentHostConfigPatchSchema } from '@solus/contracts/host-config'
import type { HostConfigSnapshot } from '@solus/contracts/host-config'
import {
  deviceConfigureRequestSchema,
  sshDeviceHostConfigsSchema,
  type DeviceConfigureRequest,
  type DeviceSettingsState,
  type DeviceState,
  type SshDeviceHostConfig,
} from '@solus/contracts/device-types'
import { personalSettingsDocumentSchema, type PersonalSettingsDocument } from '@solus/contracts/settings'
import {
  AGENT_PROFILE_MAX_ENTRIES,
  AGENT_PROFILE_MAX_FILE_BYTES,
  agentProfileEntrySchema,
  agentProfileFrom,
  agentProfileKeySchema,
  isAgentProfilePath,
  type AgentProfile,
  type AgentProfileEntry,
  type AgentProfileFileEntry,
  type AgentProfileKey,
} from '@solus/contracts/agent-profile'
import { agentDeviceSettingsPatchSchema, type AgentPersonalReply, type AgentPersonalRequest, type AgentProfileSummary } from '@solus/contracts/agent-personal-request'
import { seatProviderSchema } from '@solus/contracts/seats'
import type { AgentTool } from './agent-tool'
import { getHostConfig, setHostConfig } from '../../../host/settings'

/**
 * The agent's view of Solus settings, in five sections, each with its owner
 * (docs/settings.md):
 * - `host`: this machine's own config. `otel` is withheld whole: its headers
 *   are the collector's credentials.
 * - `deviceManager`: the host's device manager, its SSH device hosts included.
 * - `personal` and `profile`: the settings and the agent profile of the person
 *   the session works for. Only their clients hold them, so the host asks one
 *   of those clients; the client applies a change as a local edit and its sync
 *   sends it on.
 * - `device`: the settings of the client device that started the turn. They
 *   never sync, so only that client is asked.
 * The agent sees every key it may set with its type, from the owners' own
 * schemas, and each section is parsed again with the owner's schema.
 */
const AGENT_VISIBLE_HOST_KEYS = HOST_CONFIG_KEYS.filter((key) => !HOST_CONFIG_AGENT_HIDDEN_KEYS.includes(key))

/**
 * The device switches, and `sshHosts`, which replaces the whole SSH host list.
 * `onboardingCompleted` is left out: it records what a client showed, not a setting.
 */
const deviceManagerPatchSchema = deviceConfigureRequestSchema.omit({ onboardingCompleted: true }).extend({ sshHosts: sshDeviceHostConfigsSchema.optional().describe('The SSH device hosts: other machines whose devices this host reaches over SSH. The list replaces the current list.') }).strict()

const [, skillEntrySchema, integrationEntrySchema] = agentProfileEntrySchema.options

/**
 * A profile change as an agent writes it. A file is its text; the host encodes it
 * and computes its hash, which an agent cannot do reliably.
 */
const profileChangeSchema = z.object({
  set: z.array(z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('file'),
      provider: seatProviderSchema,
      /** Relative to the provider's home: `skills/review/SKILL.md`, `agents/reviewer.md`. */
      path: z.string().min(1).max(512),
      content: z.string(),
      executable: z.boolean().optional(),
    }).strict(),
    skillEntrySchema,
    integrationEntrySchema,
  ])).max(AGENT_PROFILE_MAX_ENTRIES).default([]),
  /** Keys as read_config lists them: `file:claude-code/agents/reviewer.md`, `skill:deploy`, `integration:deepwiki`. */
  remove: z.array(agentProfileKeySchema).max(AGENT_PROFILE_MAX_ENTRIES).default([]),
}).strict()

const SECTION_SCHEMAS = {
  host: agentHostConfigPatchSchema,
  deviceManager: deviceManagerPatchSchema,
  personal: personalSettingsDocumentSchema,
  profile: profileChangeSchema,
  device: agentDeviceSettingsPatchSchema,
}

/**
 * A section's schema as a provider can list it. The owners' schemas heal and
 * transform values, which the Claude SDK cannot turn into JSON Schema; their
 * input side as plain JSON Schema describes the same keys and values.
 */
function listedSchema(schema: z.ZodType): z.ZodType {
  return z.fromJSONSchema(z.toJSONSchema(schema, { io: 'input' }))
}

/** What the tools reach outside the host config, set once at server start. */
export interface ConfigToolHost {
  /** Reaches every mounted client the same way a change made in Settings does. */
  hostConfigChanged(snapshot: HostConfigSnapshot): void
  deviceManager: {
    settings(): DeviceSettingsState
    configure(request: DeviceConfigureRequest): Promise<DeviceState>
    saveSshHosts(hosts: SshDeviceHostConfig[]): Promise<DeviceState>
  }
  /**
   * Reads the person's settings, agent profile, and device, and changes what the
   * request names, through one of their clients. `fromTurnClient` says whether
   * that client started the turn: only then is its device the turn's device.
   */
  personal(sessionId: string | undefined, request: AgentPersonalRequest): Promise<{ reply: AgentPersonalReply; fromTurnClient: boolean }>
}

let host: ConfigToolHost | null = null

export function setConfigToolHost(next: ConfigToolHost): void {
  host = next
}

function visibleHostConfig(config: HostConfigSnapshot['config']) {
  return Object.fromEntries(AGENT_VISIBLE_HOST_KEYS.map((key) => [key, config[key]]))
}

function visibleDeviceManager(): Omit<DeviceSettingsState, 'onboardingCompleted'> | null {
  const settings = host?.deviceManager.settings()
  if (!settings) return null
  const { enabled, agentAccessEnabled, autoShowAgentDevices, sshHosts } = settings
  return { enabled, agentAccessEnabled, autoShowAgentDevices, sshHosts }
}

export const readConfigAgentTool: AgentTool = {
  name: 'read_config',
  description:
    "Read Solus settings in five sections: `host` (this machine: tool availability, restart continuation, review warming, retention, analytics consent), `deviceManager` (simulators, emulators, and phones, and the SSH device hosts), `personal` (the settings of the person this session works for: models, permission mode, review, instructions, source control writing, appearance, and the rest), `profile` (their agent profile: provider files such as subagents and commands, skills, and MCP servers; a file shows its path, size, and hash, not its content), and `device` (the client device that started this turn: voice, editor and terminal, font smoothing and overrides, zoom, keybindings, analytics consent). update_config changes any of them.",
  inputFields: {} as const,
  requiresApproval: false,
  execute: async (_input, context) => {
    const answer = host ? await host.personal(context.sessionId(), {}) : { reply: { ok: false as const, error: 'Personal settings are not available on this host.' }, fromTurnClient: false }
    const personal = answer.reply
    return {
      ok: true,
      text: JSON.stringify({
        host: visibleHostConfig(getHostConfig().config),
        deviceManager: visibleDeviceManager(),
        personal: personal.ok ? personal.settings : { unavailable: personal.error },
        profile: personal.ok ? profileByKey(personal.profile) : { unavailable: personal.error },
        device: turnDevice(answer),
        withheldKeys: { host: HOST_CONFIG_AGENT_HIDDEN_KEYS },
      }),
    }
  },
}

type SectionName = keyof typeof SECTION_SCHEMAS

/** The turn's device, from the client that started the turn, or why there is none. */
function turnDevice(answer: { reply: AgentPersonalReply; fromTurnClient: boolean }) {
  if (!answer.reply.ok) return { unavailable: answer.reply.error }
  if (!answer.fromTurnClient) return { unavailable: 'The client that started this turn is not connected; another client answered.' }
  return answer.reply.device ?? { unavailable: 'The client that started this turn keeps no device settings an agent can change.' }
}

interface UpdateResult {
  changed: Partial<Record<SectionName, string[]>>
  host: ReturnType<typeof visibleHostConfig>
  deviceManager: ReturnType<typeof visibleDeviceManager>
  personal?: PersonalSettingsDocument
  profile?: ReturnType<typeof profileByKey>
  device?: ReturnType<typeof turnDevice>
}

export const updateConfigAgentTool: AgentTool = {
  name: 'update_config',
  description:
    "Change Solus settings. Pass any of `host`, `deviceManager`, `personal`, `profile`, and `device`. All but `profile` take only the keys to change; keys not named keep their value. `profile` takes entries to `set` (a file by its text) and keys to `remove`. A personal or profile change is applied on the person's connected Solus client and syncs from there; a `device` change applies only on the client that started this turn and never syncs. Every key is checked before any is written.",
  inputFields: {
    host: listedSchema(SECTION_SCHEMAS.host).optional().describe("This machine's settings."),
    deviceManager: listedSchema(SECTION_SCHEMAS.deviceManager).optional().describe('The device manager. `sshHosts` replaces the whole SSH device host list.'),
    personal: listedSchema(SECTION_SCHEMAS.personal).optional().describe('The settings of the person this session works for.'),
    profile: listedSchema(SECTION_SCHEMAS.profile).optional().describe("The person's agent profile: entries to set, keys to remove."),
    device: listedSchema(SECTION_SCHEMAS.device).optional().describe('The client device that started this turn. `keybindings` replaces the whole override map.'),
  } as const,
  requiresApproval: false,
  execute: async (input, context) => {
    const parsed = parseSections(input)
    if (!parsed.ok) return { ok: false, text: parsed.error }
    const { sections } = parsed
    if (!sections.host && !sections.deviceManager && !sections.personal && !sections.profile && !sections.device) return { ok: false, text: 'Name at least one setting to change.' }
    if (!host && (sections.deviceManager || sections.personal || sections.profile || sections.device)) return { ok: false, text: 'Device and personal settings are not available on this host.' }

    // The person's part is the one that can fail out of the host's hands, so it
    // goes first: a refused change changes nothing anywhere.
    const answer = await applyPersonal(sections, context.sessionId())
    if (answer && !answer.reply.ok) return { ok: false, text: answer.reply.error }
    const changed = { ...personalChanges(sections), ...(await applyHostAndDevices(sections)) }
    const result: UpdateResult = { changed, host: visibleHostConfig(getHostConfig().config), deviceManager: visibleDeviceManager() }
    if (answer?.reply.ok) {
      result.personal = answer.reply.settings
      result.profile = profileByKey(answer.reply.profile)
      result.device = turnDevice(answer)
    }
    return { ok: true, text: JSON.stringify(result) }
  },
}

/** The person's settings, profile, and device change in one request to their client; null when the call names none. */
async function applyPersonal(sections: Sections, sessionId: string | undefined) {
  if (!host || (!sections.personal && !sections.profile && !sections.device)) return null
  const request: AgentPersonalRequest = {}
  if (sections.personal) request.settings = sections.personal
  if (sections.profile) request.profile = sections.profile
  if (sections.device) request.device = sections.device
  return host.personal(sessionId, request)
}

function personalChanges(sections: Sections): UpdateResult['changed'] {
  const changed: UpdateResult['changed'] = {}
  if (sections.personal) changed.personal = Object.keys(sections.personal)
  if (sections.profile) changed.profile = [...Object.keys(sections.profile.set), ...sections.profile.reset]
  if (sections.device) changed.device = Object.keys(sections.device)
  return changed
}

async function applyHostAndDevices(sections: Sections): Promise<UpdateResult['changed']> {
  const changed: UpdateResult['changed'] = {}
  if (sections.host) {
    host?.hostConfigChanged(setHostConfig(sections.host))
    changed.host = Object.keys(sections.host)
  }
  if (sections.deviceManager && host) {
    const { sshHosts, ...switches } = sections.deviceManager
    if (Object.keys(switches).length > 0) await host.deviceManager.configure(switches)
    if (sshHosts) await host.deviceManager.saveSshHosts(sshHosts)
    changed.deviceManager = Object.keys(sections.deviceManager)
  }
  return changed
}

/** The summary keyed as `remove` takes keys, so an agent can name what it read. */
function profileByKey(summary: AgentProfileSummary) {
  return Object.fromEntries(summary.map((entry) => [entry.kind === 'file' ? `file:${entry.provider}/${entry.path}` : entry.kind === 'skill' ? `skill:${entry.name}` : `integration:${entry.slug}`, entry]))
}

interface Sections {
  host: z.output<typeof SECTION_SCHEMAS.host> | null
  deviceManager: z.output<typeof SECTION_SCHEMAS.deviceManager> | null
  personal: z.output<typeof SECTION_SCHEMAS.personal> | null
  profile: ProfileChange | null
  device: z.output<typeof SECTION_SCHEMAS.device> | null
}

type SectionsRead = { ok: true; sections: Sections } | { ok: false; error: string }

/** Every section is checked with its owner's schema before any is written; the first refused value is named. */
function parseSections(input: { host?: unknown; deviceManager?: unknown; personal?: unknown; profile?: unknown; device?: unknown }): SectionsRead {
  const host = SECTION_SCHEMAS.host.safeParse(input.host ?? {})
  const deviceManager = SECTION_SCHEMAS.deviceManager.safeParse(input.deviceManager ?? {})
  const personal = SECTION_SCHEMAS.personal.safeParse(input.personal ?? {})
  const profile = SECTION_SCHEMAS.profile.safeParse(input.profile ?? {})
  const device = SECTION_SCHEMAS.device.safeParse(input.device ?? {})
  for (const [section, result] of [['host', host], ['deviceManager', deviceManager], ['personal', personal], ['profile', profile], ['device', device]] as const) {
    if (result.success) continue
    const issue = result.error.issues[0]
    return { ok: false, error: `${[section, ...(issue?.path ?? [])].join('.')}: ${issue?.message ?? 'invalid value'}` }
  }
  const profileChange = profile.data && toProfileChange(profile.data)
  if (profileChange && !profileChange.ok) return profileChange
  return {
    ok: true,
    sections: {
      host: nonEmpty(host.data),
      deviceManager: nonEmpty(deviceManager.data),
      device: nonEmpty(device.data),
      personal: nonEmpty(personal.data),
      profile: profileChange && (Object.keys(profileChange.change.set).length > 0 || profileChange.change.reset.length > 0) ? profileChange.change : null,
    },
  }
}

/** A profile change as the client applies it: entries by key, and keys to remove. */
interface ProfileChange {
  set: AgentProfile
  reset: AgentProfileKey[]
}

type ProfileChangeRead = { ok: true; change: ProfileChange } | { ok: false; error: string }

/** Files become entries: the host encodes the text and hashes the bytes. Skills and MCP servers were checked by their own schemas. */
function toProfileChange(change: z.output<typeof profileChangeSchema>): ProfileChangeRead {
  const entries: AgentProfileEntry[] = []
  for (const [index, candidate] of change.set.entries()) {
    if (candidate.kind !== 'file') {
      entries.push(candidate)
      continue
    }
    if (!isAgentProfilePath(candidate.provider, candidate.path)) {
      return { ok: false, error: `profile.set.${index}.path: ${candidate.path} is not a file inside a ${candidate.provider} profile folder (skills, agents, commands, or prompts).` }
    }
    const bytes = Buffer.from(candidate.content, 'utf8')
    if (bytes.byteLength > AGENT_PROFILE_MAX_FILE_BYTES) return { ok: false, error: `profile.set.${index}: a profile file holds at most ${AGENT_PROFILE_MAX_FILE_BYTES} bytes.` }
    const file: AgentProfileFileEntry = {
      kind: 'file',
      provider: candidate.provider,
      path: candidate.path,
      contentBase64: bytes.toString('base64'),
      hash: createHash('sha256').update(bytes).digest('hex'),
    }
    if (candidate.executable !== undefined) file.executable = candidate.executable
    entries.push(file)
  }
  // SAFETY: each key passed `agentProfileKeySchema`, the pattern of an `AgentProfileKey`.
  return { ok: true, change: { set: agentProfileFrom(entries), reset: change.remove as AgentProfileKey[] } }
}

function nonEmpty<T extends object>(value: T | undefined): T | null {
  return value && Object.keys(value).length > 0 ? value : null
}
