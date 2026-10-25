import {
  AGENT_PERSONAL_REQUEST,
  agentPersonalRequestSchema,
  type AgentDeviceSettings,
  type AgentDeviceSettingsPatch,
  type AgentPersonalReply,
  type AgentProfileSummary,
  type AgentProfileWrite,
} from '@solus/contracts/agent-personal-request'
import type { AgentProfile } from '@solus/contracts/agent-profile'
import type { PersonalSettings, PersonalSettingsDocument } from '@solus/contracts/settings'
import type { WsTransport } from './ws-transport'

/** The person's settings and agent profile as this client holds them. */
export interface AgentPersonalTarget {
  /** Every setting, defaults filled in, as a plain object. */
  settings(): PersonalSettings
  /** A local edit: stored here, then synced like one the person made. False when a value fails its schema. */
  applySettings(patch: PersonalSettingsDocument): boolean
  profile(): AgentProfile
  /** A local edit of the profile, as one change. False when an entry fails its schema. */
  applyProfile(change: AgentProfileWrite): boolean
  /** This device's own settings. Absent on a client that keeps none an agent may change. */
  device?: {
    current(): AgentDeviceSettings
    /** Applied as Settings applies it, on this device only. False when a value is refused. */
    apply(patch: AgentDeviceSettingsPatch): boolean
  }
}

const UNREADABLE: AgentPersonalReply = {
  ok: false,
  error: 'The client could not read the request. Update Solus on that device.',
}

/**
 * Answers the host's requests to read or change this person's settings and agent
 * profile, and this device's settings, for an agent (`read_config` and
 * `update_config`). The host chose this client; the target's schemas check the
 * values. A device change is checked first, then the settings, then the profile,
 * so a refused part leaves the parts after it as they were.
 */
export function answerAgentPersonalRequests(transport: Pick<WsTransport, 'onServerRequest'>, target: AgentPersonalTarget): () => void {
  return transport.onServerRequest(
    AGENT_PERSONAL_REQUEST,
    agentPersonalRequestSchema,
    async (request): Promise<AgentPersonalReply> => {
      if (request.device && !target.device) return { ok: false, error: 'This client keeps no device settings an agent can change.' }
      if (request.device && !target.device?.apply(request.device)) return { ok: false, error: 'The client refused a device setting.' }
      if (request.settings && !target.applySettings(request.settings)) {
        return { ok: false, error: 'The client refused a value in the settings.' }
      }
      if (request.profile && !target.applyProfile(request.profile)) {
        return { ok: false, error: 'The client refused an entry in the agent profile.' }
      }
      return { ok: true, settings: target.settings(), profile: summarizeAgentProfile(target.profile()), device: target.device?.current() ?? null }
    },
    UNREADABLE,
  )
}

/** The profile without file contents: an agent reads a file's path, size, and hash. */
export function summarizeAgentProfile(profile: AgentProfile): AgentProfileSummary {
  return Object.values(profile).map((entry) => {
    if (entry.kind !== 'file') return entry
    const { contentBase64, ...file } = entry
    // Read from the base64 length, so megabytes of content are never decoded to measure them.
    const padding = contentBase64.endsWith('==') ? 2 : contentBase64.endsWith('=') ? 1 : 0
    return { ...file, bytes: (contentBase64.length / 4) * 3 - padding }
  })
}
