import {
  AGENT_PERSONAL_SETTINGS_REQUEST,
  agentPersonalSettingsRequestSchema,
  type AgentPersonalSettingsReply,
  type PersonalSettings,
  type PersonalSettingsDocument,
} from '@solus/contracts/settings'
import type { WsTransport } from './ws-transport'

/** The person's settings as this client holds them. */
export interface AgentSettingsTarget {
  /** Every key, defaults filled in, as a plain object. */
  current(): PersonalSettings
  /** A local edit: stored here, then synced like one the person made. False when a value fails its schema. */
  apply(patch: PersonalSettingsDocument): boolean
}

const UNREADABLE: AgentPersonalSettingsReply = {
  ok: false,
  error: 'The client could not read the request. Update Solus on that device.',
}

/**
 * Answers the host's requests to read or change this person's settings for an
 * agent (`read_config` and `update_config`). The host chose this client and
 * checked the keys; the target's schemas check the values.
 */
export function answerAgentSettingsRequests(transport: Pick<WsTransport, 'onServerRequest'>, target: AgentSettingsTarget): () => void {
  return transport.onServerRequest(
    AGENT_PERSONAL_SETTINGS_REQUEST,
    agentPersonalSettingsRequestSchema,
    async (request): Promise<AgentPersonalSettingsReply> => {
      if (request.patch && !target.apply(request.patch)) {
        return { ok: false, error: 'The client refused a value in the patch.' }
      }
      return { ok: true, settings: target.current() }
    },
    UNREADABLE,
  )
}
