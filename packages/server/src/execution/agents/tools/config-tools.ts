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
import {
  personalSettingsDocumentSchema,
  type AgentPersonalSettingsReply,
  type PersonalSettingsDocument,
} from '@solus/contracts/settings'
import type { AgentTool } from './agent-tool'
import { getHostConfig, setHostConfig } from '../../../host/settings'

/**
 * The agent's view of Solus settings, in three sections, each with its owner
 * (docs/settings.md):
 * - `host`: this machine's own config. `otel` is withheld whole: its headers
 *   are the collector's credentials.
 * - `devices`: the host's device manager, its SSH device hosts included.
 * - `personal`: the settings of the person the session works for. Only their
 *   clients hold them, so the host asks one of those clients; the client
 *   applies a change as a local edit and its sync sends it on.
 * The agent sees every key it may set with its type, from the owners' own
 * schemas, and each section is parsed again with the owner's schema.
 */
const AGENT_VISIBLE_HOST_KEYS = HOST_CONFIG_KEYS.filter((key) => !HOST_CONFIG_AGENT_HIDDEN_KEYS.includes(key))

/** The device switches, and `sshHosts`, which replaces the whole SSH host list. */
const devicePatchSchema = deviceConfigureRequestSchema.extend({ sshHosts: sshDeviceHostConfigsSchema.optional() }).strict()

const SECTION_SCHEMAS = {
  host: agentHostConfigPatchSchema,
  devices: devicePatchSchema,
  personal: personalSettingsDocumentSchema,
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
  devices: {
    settings(): DeviceSettingsState
    configure(request: DeviceConfigureRequest): Promise<DeviceState>
    saveSshHosts(hosts: SshDeviceHostConfig[]): Promise<DeviceState>
  }
  /** Reads the person's settings, or changes them when `patch` is given, through one of their clients. */
  personalSettings(sessionId: string | undefined, patch?: PersonalSettingsDocument): Promise<AgentPersonalSettingsReply>
}

let host: ConfigToolHost | null = null

export function setConfigToolHost(next: ConfigToolHost): void {
  host = next
}

function visibleHostConfig(config: HostConfigSnapshot['config']) {
  return Object.fromEntries(AGENT_VISIBLE_HOST_KEYS.map((key) => [key, config[key]]))
}

function visibleDeviceSettings(): Omit<DeviceSettingsState, 'onboardingCompleted'> | null {
  const settings = host?.devices.settings()
  if (!settings) return null
  const { enabled, agentAccessEnabled, autoShowAgentDevices, sshHosts } = settings
  return { enabled, agentAccessEnabled, autoShowAgentDevices, sshHosts }
}

export const readConfigAgentTool: AgentTool = {
  name: 'read_config',
  description:
    "Read Solus settings in three sections: `host` (this machine: tool availability, restart continuation, review warming, retention, analytics consent), `devices` (the device manager and its SSH device hosts), and `personal` (the settings of the person this session works for: models, permission mode, review, instructions, source control writing, appearance, and the rest). update_config changes any of them.",
  inputFields: {} as const,
  requiresApproval: false,
  execute: async (_input, context) => {
    const personal = host ? await host.personalSettings(context.sessionId()) : { ok: false as const, error: 'Personal settings are not available on this host.' }
    return {
      ok: true,
      text: JSON.stringify({
        host: visibleHostConfig(getHostConfig().config),
        devices: visibleDeviceSettings(),
        personal: personal.ok ? personal.settings : { unavailable: personal.error },
        withheldKeys: { host: HOST_CONFIG_AGENT_HIDDEN_KEYS },
      }),
    }
  },
}

type SectionName = 'host' | 'devices' | 'personal'

interface UpdateResult {
  changed: Partial<Record<SectionName, string[]>>
  host: ReturnType<typeof visibleHostConfig>
  devices: ReturnType<typeof visibleDeviceSettings>
  personal?: PersonalSettingsDocument
}

export const updateConfigAgentTool: AgentTool = {
  name: 'update_config',
  description:
    "Change Solus settings. Pass any of `host`, `devices`, and `personal`, each with only the keys to change; keys not named keep their value. A personal change is applied on the person's connected Solus client and syncs from there. Every key is checked before any is written.",
  inputFields: {
    host: listedSchema(SECTION_SCHEMAS.host).optional().describe("This machine's settings."),
    devices: listedSchema(SECTION_SCHEMAS.devices).optional().describe('The device manager. `sshHosts` replaces the whole SSH device host list.'),
    personal: listedSchema(SECTION_SCHEMAS.personal).optional().describe('The settings of the person this session works for.'),
  } as const,
  requiresApproval: false,
  execute: async (input, context) => {
    const parsed = parseSections(input)
    if (!parsed.ok) return { ok: false, text: parsed.error }
    const { sections } = parsed
    if (!sections.host && !sections.devices && !sections.personal) return { ok: false, text: 'Name at least one setting to change.' }
    if (!host && (sections.devices || sections.personal)) return { ok: false, text: 'Device and personal settings are not available on this host.' }

    // The personal section is the one that can fail out of the host's hands, so
    // it goes first: a refused change changes nothing anywhere.
    const changed: UpdateResult['changed'] = {}
    let personal: PersonalSettingsDocument | null = null
    if (sections.personal && host) {
      const reply = await host.personalSettings(context.sessionId(), sections.personal)
      if (!reply.ok) return { ok: false, text: reply.error }
      personal = reply.settings
      changed.personal = Object.keys(sections.personal)
    }
    if (sections.host) {
      host?.hostConfigChanged(setHostConfig(sections.host))
      changed.host = Object.keys(sections.host)
    }
    if (sections.devices && host) {
      const { sshHosts, ...switches } = sections.devices
      if (Object.keys(switches).length > 0) await host.devices.configure(switches)
      if (sshHosts) await host.devices.saveSshHosts(sshHosts)
      changed.devices = Object.keys(sections.devices)
    }
    const result: UpdateResult = { changed, host: visibleHostConfig(getHostConfig().config), devices: visibleDeviceSettings() }
    if (personal) result.personal = personal
    return { ok: true, text: JSON.stringify(result) }
  },
}

interface Sections {
  host: z.output<typeof SECTION_SCHEMAS.host> | null
  devices: z.output<typeof SECTION_SCHEMAS.devices> | null
  personal: z.output<typeof SECTION_SCHEMAS.personal> | null
}

type SectionsRead = { ok: true; sections: Sections } | { ok: false; error: string }

/** Every section is checked with its owner's schema before any is written; the first refused value is named. */
function parseSections(input: { host?: unknown; devices?: unknown; personal?: unknown }): SectionsRead {
  const host = SECTION_SCHEMAS.host.safeParse(input.host ?? {})
  const devices = SECTION_SCHEMAS.devices.safeParse(input.devices ?? {})
  const personal = SECTION_SCHEMAS.personal.safeParse(input.personal ?? {})
  for (const [section, result] of [['host', host], ['devices', devices], ['personal', personal]] as const) {
    if (result.success) continue
    const issue = result.error.issues[0]
    return { ok: false, error: `${[section, ...(issue?.path ?? [])].join('.')}: ${issue?.message ?? 'invalid value'}` }
  }
  return { ok: true, sections: { host: nonEmpty(host.data), devices: nonEmpty(devices.data), personal: nonEmpty(personal.data) } }
}

function nonEmpty<T extends object>(value: T | undefined): T | null {
  return value && Object.keys(value).length > 0 ? value : null
}
