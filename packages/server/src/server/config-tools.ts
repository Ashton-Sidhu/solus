import { z } from 'zod'
import {
  AGENT_WRITABLE_HOST_CONFIG_KEYS,
  HOST_CONFIG_AGENT_HIDDEN_KEYS,
  hostConfigPatchSchema,
  isAgentWritableHostConfigKey,
} from '@solus/contracts/host-config'
import type { HostConfigSnapshot } from '@solus/contracts/host-config'
import type { AgentTool } from '../agents/tools/agent-tool'
import { getHostConfig, setHostConfig } from './settings'

/**
 * The agent's view of host config: read anything, write only what the key
 * policy opens. See `HOST_CONFIG_AGENT_WRITABLE` for why four keys are closed.
 *
 * Host config holds no credentials, so `read_config` has nothing to redact —
 * connections live in the encrypted secret store and are reached through their
 * own status tools.
 */

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
    "Read this host's Solus configuration — theme, fonts, default agent and models, editor, review companion, and other settings that follow the user between their devices. Reports which keys update_config accepts.",
  inputFields: {} as const,
  requiresApproval: false,
  execute: async () => {
    const { config, seeded } = getHostConfig()
    const visible = { ...config }
    for (const key of HOST_CONFIG_AGENT_HIDDEN_KEYS) delete visible[key]
    return {
      ok: true,
      text: JSON.stringify({
        config: visible,
        // Reported so an agent does not read defaults as the user's choices.
        seeded,
        writableKeys: AGENT_WRITABLE_HOST_CONFIG_KEYS,
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
    "Change this host's Solus configuration. `patch` is a JSON object of the keys to change; keys not named keep their current value. Only the keys read_config reports as writable are accepted — instructions and analytics consent are the user's to set, not yours.",
  inputFields: {
    patch: z.string().describe('JSON object of host config keys to change, e.g. {"themeMode":"light","fontSize":14}'),
  } as const,
  requiresApproval: true,
  execute: async (input) => {
    const args = updateConfigArgsSchema.safeParse(input)
    if (!args.success) return { ok: false, text: '`patch` is required and must be a string.' }

    const candidate = readJsonObject(args.data.patch)
    if (!candidate.ok) return { ok: false, text: candidate.error }

    const refused = candidate.keys.filter((key) => !isAgentWritableHostConfigKey(key))
    if (refused.length > 0) {
      // Named rather than silently dropped: an agent that believes it applied a
      // setting will tell the user it did.
      return {
        ok: false,
        text: `These keys cannot be set by an agent: ${refused.join(', ')}. Writable keys are: ${AGENT_WRITABLE_HOST_CONFIG_KEYS.join(', ')}.`,
      }
    }

    const patch = hostConfigPatchSchema.parse(candidate.value)
    const changed = Object.keys(patch)
    if (changed.length === 0) {
      return { ok: false, text: 'No recognized host config keys in the patch.' }
    }

    const snapshot = setHostConfig(patch)
    notifyChanged?.(snapshot)
    return { ok: true, text: JSON.stringify({ changed, config: snapshot.config }) }
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
    return { ok: false, error: '`patch` must be valid JSON, e.g. {"themeMode":"light"}.' }
  }
  const parsed = patchObjectSchema.safeParse(decoded)
  if (!parsed.success) {
    return { ok: false, error: '`patch` must be a JSON object, not an array or a bare value.' }
  }
  return { ok: true, keys: Object.keys(parsed.data), value: parsed.data }
}
