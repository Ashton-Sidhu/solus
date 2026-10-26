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
import { agentDeviceSettingsPatchSchema, type AgentPersonalReply, type AgentPersonalRequest } from '@solus/contracts/agent-personal-request'
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
}).strict().transform((change, context): ProfileChange | null => {
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
  if (entries.length === 0 && change.remove.length === 0) return null
  // SAFETY: each key passed `agentProfileKeySchema`, the pattern of an `AgentProfileKey`.
  return { set: agentProfileFrom(entries), reset: change.remove as AgentProfileKey[] }
})

/** A profile change as the client applies it: entries by key, and keys to remove. */
interface ProfileChange {
  set: AgentProfile
  reset: AgentProfileKey[]
}

/**
 * Every section an agent may change, each its owner's own schema. The parse is
 * the boundary: every section is checked before any is written, and the first
 * refused value is named by its path, `section.key`.
 */
const updateConfigInputSchema = z.object({
  host: agentHostConfigPatchSchema.optional().describe("This machine's settings."),
  deviceManager: deviceManagerPatchSchema.optional().describe('The device manager. `sshHosts` replaces the whole SSH device host list.'),
  personal: personalSettingsDocumentSchema.optional().describe('The settings of the person this session works for.'),
  profile: profileChangeSchema.optional().describe("The person's agent profile: entries to set, keys to remove."),
  device: agentDeviceSettingsPatchSchema.optional().describe('The client device that started this turn. `keybindings` replaces the whole override map.'),
}).strict()

/** The sections of one update_config call, each checked by its owner's schema. */
type Sections = z.output<typeof updateConfigInputSchema>
type SectionName = keyof Sections

/**
 * A section's schema as a provider can list it. The owners' schemas heal and
 * transform values, which the Claude SDK cannot turn into JSON Schema; their
 * input side as plain JSON Schema describes the same keys and values. Defaults
 * are left out: the call is parsed against this schema first, and a default
 * there would write a key the agent did not name (a healing `.catch` lists as one).
 */
function listedSchema(schema: z.ZodType): z.ZodType {
  return z.fromJSONSchema(z.toJSONSchema(schema, { io: 'input', override: ({ jsonSchema }) => { delete jsonSchema.default } }))
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

/** The keys a write named, by section, as update_config reports them. */
type ChangedKeys = { [K in SectionName]?: string[] }

/** The keys a keyed section names; the profile names entries instead. */
function keysOf(section: Sections[Exclude<SectionName, 'profile'>]): string[] {
  return section ? Object.keys(section) : []
}

/** This host's own config, as an agent sees it: every key but the collector's credentials. */
class HostConfigOwner {
  constructor(private readonly announce: (snapshot: HostConfigSnapshot) => void) {}

  read() {
    const { config } = getHostConfig()
    return Object.fromEntries(AGENT_VISIBLE_HOST_KEYS.map((key) => [key, config[key]]))
  }

  /** Answers the keys it wrote. An empty patch writes nothing. */
  write(patch: Sections['host']): string[] {
    const keys = keysOf(patch)
    if (patch && keys.length > 0) this.announce(setHostConfig(patch))
    return keys
  }
}

/** The host's device manager: its switches and its SSH device hosts. */
class DeviceManagerOwner {
  constructor(private readonly manager: ConfigToolHost['deviceManager']) {}

  read(): Omit<DeviceSettingsState, 'onboardingCompleted'> {
    const { enabled, agentAccessEnabled, autoShowAgentDevices, sshHosts } = this.manager.settings()
    return { enabled, agentAccessEnabled, autoShowAgentDevices, sshHosts }
  }

  /** Answers the keys it wrote. `sshHosts` replaces the whole list. */
  async write(patch: Sections['deviceManager']): Promise<string[]> {
    if (!patch) return []
    const { sshHosts, ...switches } = patch
    if (Object.keys(switches).length > 0) await this.manager.configure(switches)
    if (sshHosts) await this.manager.saveSshHosts(sshHosts)
    return keysOf(patch)
  }
}

type PersonView = ReturnType<PersonOwner['view']>
type PersonWrite = { ok: true; changed: ChangedKeys; view: PersonView } | { ok: false; error: string }

/**
 * The person a session works for, as their clients hold them: their settings,
 * their agent profile, and the device that started the turn. One request to one
 * of their clients reads or writes all three.
 */
class PersonOwner {
  constructor(
    private readonly ask: ConfigToolHost['personal'],
    private readonly sessionId: string | undefined,
  ) {}

  async read(): Promise<PersonView> {
    return this.view(await this.ask(this.sessionId, {}))
  }

  /** Writes what the sections name, as one request; null when they name nothing of the person's. */
  async write({ personal, profile, device }: Pick<Sections, 'personal' | 'profile' | 'device'>): Promise<PersonWrite | null> {
    const request: AgentPersonalRequest = {}
    const changed: ChangedKeys = {}
    if (personal && keysOf(personal).length > 0) {
      request.settings = personal
      changed.personal = keysOf(personal)
    }
    if (profile) {
      request.profile = profile
      changed.profile = [...Object.keys(profile.set), ...profile.reset]
    }
    if (device && keysOf(device).length > 0) {
      request.device = device
      changed.device = keysOf(device)
    }
    if (Object.keys(changed).length === 0) return null
    const answer = await this.ask(this.sessionId, request)
    if (!answer.reply.ok) return { ok: false, error: answer.reply.error }
    return { ok: true, changed, view: this.view(answer) }
  }

  /** The person's three sections from a client's answer, or why each is unavailable. */
  view(answer: PersonalAnswer) {
    const { reply } = answer
    if (!reply.ok) return { personal: { unavailable: reply.error }, profile: { unavailable: reply.error }, device: { unavailable: reply.error } }
    return {
      personal: reply.settings,
      // Keyed as `remove` takes keys, so an agent can name what it read.
      profile: Object.fromEntries(reply.profile.map((entry) => [entry.kind === 'file' ? `file:${entry.provider}/${entry.path}` : entry.kind === 'skill' ? `skill:${entry.name}` : `integration:${entry.slug}`, entry])),
      device: !answer.fromTurnClient
        ? { unavailable: 'The client that started this turn is not connected; another client answered.' }
        : reply.device ?? { unavailable: 'The client that started this turn keeps no device settings an agent can change.' },
    }
  }
}

const NO_PERSON = 'Personal settings are not available on this host.'

/** The settings one session's agent reaches, by their owners: this host, its device manager, and the person the session works for. */
class AgentSettings {
  private readonly hostConfig: HostConfigOwner
  private readonly deviceManager: DeviceManagerOwner | null
  private readonly person: PersonOwner | null

  constructor(host: ConfigToolHost | null, sessionId: string | undefined) {
    this.hostConfig = new HostConfigOwner((snapshot) => host?.hostConfigChanged(snapshot))
    this.deviceManager = host ? new DeviceManagerOwner(host.deviceManager) : null
    this.person = host ? new PersonOwner((session, request) => host.personal(session, request), sessionId) : null
  }

  async read() {
    const person = this.person ? await this.person.read() : { personal: { unavailable: NO_PERSON }, profile: { unavailable: NO_PERSON }, device: { unavailable: NO_PERSON } }
    return { host: this.hostConfig.read(), deviceManager: this.deviceManager?.read() ?? null, ...person, withheldKeys: { host: HOST_CONFIG_AGENT_HIDDEN_KEYS } }
  }

  /**
   * The person goes first: their client can refuse, and a refused write changes
   * nothing on this host either.
   */
  async write(sections: Sections): Promise<AgentToolResult> {
    const namesPerson = keysOf(sections.personal).length > 0 || Boolean(sections.profile) || keysOf(sections.device).length > 0
    if ((!this.person && namesPerson) || (!this.deviceManager && keysOf(sections.deviceManager).length > 0)) {
      return { ok: false, text: 'Device and personal settings are not available on this host.' }
    }
    const person = await this.person?.write(sections) ?? null
    if (person && !person.ok) return { ok: false, text: person.error }
    const changed: ChangedKeys = { ...person?.changed }
    const hostKeys = this.hostConfig.write(sections.host)
    if (hostKeys.length > 0) changed.host = hostKeys
    const deviceManagerKeys = await this.deviceManager?.write(sections.deviceManager) ?? []
    if (deviceManagerKeys.length > 0) changed.deviceManager = deviceManagerKeys
    if (Object.keys(changed).length === 0) return { ok: false, text: 'Name at least one setting to change.' }
    const result = { changed, host: this.hostConfig.read(), deviceManager: this.deviceManager?.read() ?? null }
    if (person) Object.assign(result, person.view)
    return { ok: true, text: JSON.stringify(result) }
  }
}

let toolHost: ConfigToolHost | null = null

export function setConfigToolHost(next: ConfigToolHost): void {
  toolHost = next
}

export const readConfigAgentTool: AgentTool = {
  name: 'read_config',
  description:
    "Read Solus settings in five sections: `host` (this machine: tool availability, restart continuation, review warming, retention, analytics consent), `deviceManager` (simulators, emulators, and phones, and the SSH device hosts), `personal` (the settings of the person this session works for: models, permission mode, review, instructions, source control writing, appearance, and the rest), `profile` (their agent profile: provider files such as subagents and commands, skills, and MCP servers; a file shows its path, size, and hash, not its content), and `device` (the client device that started this turn: voice, editor and terminal, font smoothing and overrides, zoom, keybindings, analytics consent). update_config changes any of them.",
  inputFields: {} as const,
  requiresApproval: false,
  execute: async (_input, context) => ({ ok: true, text: JSON.stringify(await new AgentSettings(toolHost, context.sessionId()).read()) }),
}

export const updateConfigAgentTool: AgentTool = {
  name: 'update_config',
  description:
    "Change Solus settings. Pass any of `host`, `deviceManager`, `personal`, `profile`, and `device`. All but `profile` take only the keys to change; keys not named keep their value. `profile` takes entries to `set` (a file by its text) and keys to `remove`. A personal or profile change is applied on the person's connected Solus client and syncs from there; a `device` change applies only on the client that started this turn and never syncs. Every key is checked before any is written.",
  // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Zod names an object schema's fields `shape`.
  inputFields: Object.fromEntries(Object.entries(updateConfigInputSchema.shape).map(([name, schema]) => [name, listedSchema(schema).optional()])),
  requiresApproval: false,
  execute: async (input, context) => {
    const parsed = updateConfigInputSchema.safeParse(input)
    if (parsed.success) return new AgentSettings(toolHost, context.sessionId()).write(parsed.data)
    // The first refused value, named by its path: `section.key`.
    const issue = parsed.error.issues[0]
    return { ok: false, text: `${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid value'}` }
  },
}
