import { z } from 'zod'
import {
  HOST_CONFIG_AGENT_HIDDEN_KEYS,
  HOST_CONFIG_KEYS,
  hostConfigPatchSchema,
  isAgentWritableHostConfigKey,
} from '@solus/contracts/host-config'
import type { HostConfigSnapshot } from '@solus/contracts/host-config'
import type { AgentTool } from './agent-tool'
import { getHostConfig, setHostConfig } from '../../../host/settings'

/**
 * The agent's view of this host's own settings (plans/018 §3.5): the keys the
 * host owns, never a person's preferences. A person's settings live with their
 * clients and account, not on a host an agent of another person can read.
 * `otel` is withheld whole: its headers are the collector's credentials. An
 * agent may write only a host-owned key the key policy opens.
 */
const AGENT_VISIBLE_KEYS = HOST_CONFIG_KEYS.filter((key) => !HOST_CONFIG_AGENT_HIDDEN_KEYS.includes(key))
const AGENT_WRITABLE_KEYS: readonly string[] = AGENT_VISIBLE_KEYS.filter((key) => isAgentWritableHostConfigKey(key)).sort()

let notifyChanged: ((snapshot: HostConfigSnapshot) => void) | null = null

/** Set once at server start, so a config write an agent makes reaches every
 *  mounted client the same way one made in Settings does. */
export function setHostConfigChangedListener(
  listener: (snapshot: HostConfigSnapshot) => void,
): void {
  notifyChanged = listener
}

export const readConfigAgentTool: AgentTool = {
  name: 'read_config',
  description:
    "Read this host's own Solus settings — tool availability, restart continuation, review warming, and automation retention. A person's preferences (theme, models, instructions) are not host settings and are not shown. Reports which keys update_config accepts.",
  inputFields: {} as const,
  requiresApproval: false,
  execute: async () => {
    const { config } = getHostConfig()
    const visible = Object.fromEntries(AGENT_VISIBLE_KEYS.map((key) => [key, config[key]]))
    return {
      ok: true,
      text: JSON.stringify({
        config: visible,
        writableKeys: AGENT_WRITABLE_KEYS,
        withheldKeys: HOST_CONFIG_AGENT_HIDDEN_KEYS,
      }),
    }
  },
}

const updateConfigArgsSchema = z.object({ patch: z.string() })

/** Zod is the parse boundary: an object here, arrays and bare values rejected,
 *  unknown keys preserved so the write policy can name them. */
const patchObjectSchema = z.looseObject({})

export const updateConfigAgentTool: AgentTool = {
  name: 'update_config',
  description:
    "Change this host's own Solus settings. `patch` is a JSON object of the keys to change; keys not named keep their current value. Only the keys read_config reports as writable are accepted — a person's preferences and instructions are theirs to set, not yours.",
  inputFields: {
    patch: z.string().describe('JSON object of host setting keys to change, e.g. {"continueSessionsAfterHostRestart":false}'),
  } as const,
  requiresApproval: true,
  execute: async (input) => {
    const args = updateConfigArgsSchema.safeParse(input)
    if (!args.success) return { ok: false, text: '`patch` is required and must be a string.' }

    const candidate = readJsonObject(args.data.patch)
    if (!candidate.ok) return { ok: false, text: candidate.error }

    const refused = candidate.keys.filter((key) => !AGENT_WRITABLE_KEYS.includes(key))
    if (refused.length > 0) {
      // Named rather than silently dropped: an agent that believes it applied a
      // setting will tell the user it did.
      return {
        ok: false,
        text: `These keys cannot be set by an agent: ${refused.join(', ')}. Writable keys are: ${AGENT_WRITABLE_KEYS.join(', ') || 'none'}.`,
      }
    }

    const patch = hostConfigPatchSchema.parse(candidate.value)
    const changed = Object.keys(patch)
    if (changed.length === 0) {
      return { ok: false, text: 'No recognized host setting keys in the patch.' }
    }

    const snapshot = setHostConfig(patch)
    notifyChanged?.(snapshot)
    const config = Object.fromEntries(AGENT_VISIBLE_KEYS.map((key) => [key, snapshot.config[key]]))
    return { ok: true, text: JSON.stringify({ changed, config }) }
  },
}

type JsonObjectRead =
  | { ok: true; keys: string[]; value: object }
  | { ok: false; error: string }

/** A malformed patch has to come back as a message the agent can act on, not an
 *  unhandled throw inside the tool call. */
function readJsonObject(raw: string): JsonObjectRead {
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    return { ok: false, error: '`patch` must be valid JSON, e.g. {"continueSessionsAfterHostRestart":false}.' }
  }
  const parsed = patchObjectSchema.safeParse(decoded)
  if (!parsed.success) {
    return { ok: false, error: '`patch` must be a JSON object, not an array or a bare value.' }
  }
  return { ok: true, keys: Object.keys(parsed.data), value: parsed.data }
}
