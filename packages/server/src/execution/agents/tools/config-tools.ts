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
import { personalSettingsDocumentSchema } from '@solus/contracts/settings'
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
import type { AgentTool, AgentToolResult } from './agent-tool'
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
 * and computes its hash, which an agent cannot do reliably. Skills and MCP
 * servers are checked by their own schemas.
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
}).strict().transform((change, context): ProfileChange => {
  const entries: AgentProfileEntry[] = []
  for (const [index, candidate] of change.set.entries()) {
    if (candidate.kind !== 'file') {
      entries.push(candidate)
      continue
    }
    if (!isAgentProfilePath(candidate.provider, candidate.path)) {
      context.addIssue({ code: 'custom', path: ['set', index, 'path'], message: `${candidate.path} is not a file inside a ${candidate.provider} profile folder (skills, agents, commands, or prompts).` })
      return z.NEVER
    }
    const bytes = Buffer.from(candidate.content, 'utf8')
    if (bytes.byteLength > AGENT_PROFILE_MAX_FILE_BYTES) {
      context.addIssue({ code: 'custom', path: ['set', index], message: `A profile file holds at most ${AGENT_PROFILE_MAX_FILE_BYTES} bytes.` })
      return z.NEVER
    }
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
  return { set: agentProfileFrom(entries), reset: change.remove as AgentProfileKey[] }
})

/** A profile change as the client applies it: entries by key, and keys to remove. */
interface ProfileChange {
  set: AgentProfile
  reset: AgentProfileKey[]
}

type Checked<T> = { ok: true; value: T } | { ok: false; error: string }

/** A section an agent named, checked: its value, or null when it names no key, and the keys it names. */
interface CheckedSection {
  value: object | null
  keys: string[]
}

/** One section of the settings an agent reaches: its owner's schema, what the agent reads about it, and its check. */
interface SectionRow<Schema extends z.ZodType<object, unknown>> {
  schema: Schema
  description: string
  /** The first refused value is named, as `section.key: message`. */
  check(name: string, raw: unknown): Checked<CheckedSection>
}

/** `changedKeys` lists the keys a change names; no key is no change. */
function section<Schema extends z.ZodType<object, unknown>>(schema: Schema, description: string, changedKeys: (value: z.output<Schema>) => string[] = Object.keys): SectionRow<Schema> {
  return {
    schema,
    description,
    check: (name, raw) => {
      const result = schema.safeParse(raw ?? {})
      if (!result.success) {
        const issue = result.error.issues[0]
        return { ok: false, error: `${[name, ...(issue?.path ?? [])].join('.')}: ${issue?.message ?? 'invalid value'}` }
      }
      const keys = changedKeys(result.data)
      return { ok: true, value: { value: keys.length > 0 ? result.data : null, keys } }
    },
  }
}

/** One row per section, as `HOST_CONFIG_FIELDS` has one row per key. */
const SECTIONS = {
  host: section(agentHostConfigPatchSchema, "This machine's settings."),
  deviceManager: section(deviceManagerPatchSchema, 'The device manager. `sshHosts` replaces the whole SSH device host list.'),
  personal: section(personalSettingsDocumentSchema, 'The settings of the person this session works for.'),
  profile: section(profileChangeSchema, "The person's agent profile: entries to set, keys to remove.", (change) => [...Object.keys(change.set), ...change.reset]),
  device: section(agentDeviceSettingsPatchSchema, 'The client device that started this turn. `keybindings` replaces the whole override map.'),
}

type SectionName = keyof typeof SECTIONS
const SECTION_NAMES: readonly SectionName[] = Object.keys(SECTIONS).filter((name): name is SectionName => Object.hasOwn(SECTIONS, name))
type Sections = { [K in SectionName]: z.output<(typeof SECTIONS)[K]['schema']> | null }

/**
 * A section's schema as a provider can list it. The owners' schemas heal and
 * transform values, which the Claude SDK cannot turn into JSON Schema; their
 * input side as plain JSON Schema describes the same keys and values.
 */
function listedSchema(schema: z.ZodType): z.ZodType {
  return z.fromJSONSchema(z.toJSONSchema(schema, { io: 'input' }))
}

/** A client's answer, and whether that client started the turn: only its device settings are the turn's device. */
export interface PersonalAnswer {
  reply: AgentPersonalReply
  fromTurnClient: boolean
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
  /** Reads the person's settings, agent profile, and device, and changes what the request names, through one of their clients. */
  personal(sessionId: string | undefined, request: AgentPersonalRequest): Promise<PersonalAnswer>
}


/** The keys a change named, by section, as update_config reports them. */
type ChangedKeys = { [K in SectionName]?: string[] }

/** One change an agent asked for, every section checked with its owner's schema before any is written. */
class ConfigChange {
  private constructor(readonly sections: Sections, readonly changedKeys: ChangedKeys) {}

  static parse(input: { [K in SectionName]?: unknown }): Checked<ConfigChange> {
    const parsed = SECTION_NAMES.map((name) => [name, SECTIONS[name].check(name, input[name])] as const)
    for (const [, result] of parsed) if (!result.ok) return result
    const sections = Object.fromEntries(parsed.map(([name, result]) => [name, result.ok ? result.value.value : null]))
    const changedKeys = Object.fromEntries(parsed.flatMap(([name, result]) => (result.ok && result.value.keys.length > 0 ? [[name, result.value.keys]] : [])))
    // SAFETY: every section name contributes the value its own schema parsed, so each key holds its own section's type.
    return { ok: true, value: new ConfigChange(sections as Sections, changedKeys) }
  }

  get isEmpty(): boolean {
    return Object.values(this.sections).every((section) => section === null)
  }

  /** The parts only a client of the person holds, as one request; null when the change names none. */
  get clientRequest(): AgentPersonalRequest | null {
    const { personal, profile, device } = this.sections
    if (!personal && !profile && !device) return null
    const request: AgentPersonalRequest = {}
    if (personal) request.settings = personal
    if (profile) request.profile = profile
    if (device) request.device = device
    return request
  }
}

/** The person's three sections from a client's answer, or why each is unavailable. */
function personalView(answer: PersonalAnswer) {
  const { reply } = answer
  if (!reply.ok) return { personal: { unavailable: reply.error }, profile: { unavailable: reply.error }, device: { unavailable: reply.error } }
  return {
    personal: reply.settings,
    profile: profileByKey(reply.profile),
    device: !answer.fromTurnClient
      ? { unavailable: 'The client that started this turn is not connected; another client answered.' }
      : reply.device ?? { unavailable: 'The client that started this turn keeps no device settings an agent can change.' },
  }
}

const NO_HOST: PersonalAnswer = { reply: { ok: false, error: 'Personal settings are not available on this host.' }, fromTurnClient: false }

/** The owners of the settings an agent reaches: this host's config, its device manager, and the person's clients. */
class SettingsOwners {
  constructor(private readonly host: ConfigToolHost | null) {}

  async read(sessionId: string | undefined) {
    const answer = this.host ? await this.host.personal(sessionId, {}) : NO_HOST
    return { host: this.hostView(), deviceManager: this.deviceManagerView(), ...personalView(answer), withheldKeys: { host: HOST_CONFIG_AGENT_HIDDEN_KEYS } }
  }

  /**
   * The person's part is the one that can fail out of the host's hands, so it
   * goes first: a refused change changes nothing anywhere.
   */
  async apply(change: ConfigChange, sessionId: string | undefined): Promise<AgentToolResult> {
    if (change.isEmpty) return { ok: false, text: 'Name at least one setting to change.' }
    const { host, deviceManager } = change.sections
    if (!this.host && (deviceManager || change.clientRequest)) return { ok: false, text: 'Device and personal settings are not available on this host.' }
    const request = change.clientRequest
    const answer = request && this.host ? await this.host.personal(sessionId, request) : null
    if (answer && !answer.reply.ok) return { ok: false, text: answer.reply.error }
    if (host) {
      const snapshot = setHostConfig(host)
      this.host?.hostConfigChanged(snapshot)
    }
    if (deviceManager && this.host) {
      const { sshHosts, ...switches } = deviceManager
      if (Object.keys(switches).length > 0) await this.host.deviceManager.configure(switches)
      if (sshHosts) await this.host.deviceManager.saveSshHosts(sshHosts)
    }
    const result = { changed: change.changedKeys, host: this.hostView(), deviceManager: this.deviceManagerView() }
    if (answer) Object.assign(result, personalView(answer))
    return { ok: true, text: JSON.stringify(result) }
  }

  private hostView() {
    const { config } = getHostConfig()
    return Object.fromEntries(AGENT_VISIBLE_HOST_KEYS.map((key) => [key, config[key]]))
  }

  private deviceManagerView(): Omit<DeviceSettingsState, 'onboardingCompleted'> | null {
    const settings = this.host?.deviceManager.settings()
    if (!settings) return null
    const { enabled, agentAccessEnabled, autoShowAgentDevices, sshHosts } = settings
    return { enabled, agentAccessEnabled, autoShowAgentDevices, sshHosts }
  }
}

let owners = new SettingsOwners(null)

export function setConfigToolHost(next: ConfigToolHost): void {
  owners = new SettingsOwners(next)
}

export const readConfigAgentTool: AgentTool = {
  name: 'read_config',
  description:
    "Read Solus settings in five sections: `host` (this machine: tool availability, restart continuation, review warming, retention, analytics consent), `deviceManager` (simulators, emulators, and phones, and the SSH device hosts), `personal` (the settings of the person this session works for: models, permission mode, review, instructions, source control writing, appearance, and the rest), `profile` (their agent profile: provider files such as subagents and commands, skills, and MCP servers; a file shows its path, size, and hash, not its content), and `device` (the client device that started this turn: voice, editor and terminal, font smoothing and overrides, zoom, keybindings, analytics consent). update_config changes any of them.",
  inputFields: {} as const,
  requiresApproval: false,
  execute: async (_input, context) => ({ ok: true, text: JSON.stringify(await owners.read(context.sessionId())) }),
}

export const updateConfigAgentTool: AgentTool = {
  name: 'update_config',
  description:
    "Change Solus settings. Pass any of `host`, `deviceManager`, `personal`, `profile`, and `device`. All but `profile` take only the keys to change; keys not named keep their value. `profile` takes entries to `set` (a file by its text) and keys to `remove`. A personal or profile change is applied on the person's connected Solus client and syncs from there; a `device` change applies only on the client that started this turn and never syncs. Every key is checked before any is written.",
  inputFields: Object.fromEntries(SECTION_NAMES.map((name) => [name, listedSchema(SECTIONS[name].schema).optional().describe(SECTIONS[name].description)])),
  requiresApproval: false,
  execute: async (input, context) => {
    const change = ConfigChange.parse(input)
    return change.ok ? owners.apply(change.value, context.sessionId()) : { ok: false, text: change.error }
  },
}

/** The summary keyed as `remove` takes keys, so an agent can name what it read. */
function profileByKey(summary: AgentProfileSummary) {
  return Object.fromEntries(summary.map((entry) => [entry.kind === 'file' ? `file:${entry.provider}/${entry.path}` : entry.kind === 'skill' ? `skill:${entry.name}` : `integration:${entry.slug}`, entry]))
}
