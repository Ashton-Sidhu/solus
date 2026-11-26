import {
  PERMISSION_MODE_LABELS,
  POLICY_PROVIDER_IDS,
  policyDocumentFields,
  type ManagedHostSettings,
  type ManagedSessionSettings,
  type PolicyDocument,
  type PolicyKind,
  type SessionLimits,
} from '@solus/contracts/policy'
import { PERMISSION_MODES } from '@solus/contracts/types'
import { policyText } from './policy-editor'

/**
 * The building blocks of Settings → Policy: the common rules as a choice
 * instead of JSON. A block reads its value from the document and writes it
 * back; the JSON stays the one source, so a block and a hand edit never
 * disagree. Keys with free values (model lists, instructions, launch pins)
 * stay in the JSON.
 */
export interface PolicyBlockChoice {
  value: string
  label: string
}

export type PolicyBlockGroup = 'Session limits' | 'Session defaults' | 'Host settings'

export interface PolicyBlock {
  id: string
  label: string
  description: string
  group: PolicyBlockGroup
  choices: readonly PolicyBlockChoice[]
  /** The choice the block starts at when it is added. */
  initial: string
  /** The value in the document; undefined when the document does not set it. */
  read: (document: PolicyDocument) => string | undefined
  /** The document with this value; undefined removes the rule. */
  write: (document: PolicyDocument, value: string | undefined) => PolicyDocument
}

export const POLICY_BLOCK_GROUPS: readonly PolicyBlockGroup[] = ['Session limits', 'Session defaults', 'Host settings']

const ON_OFF: readonly PolicyBlockChoice[] = [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]
const MODE_CHOICES: readonly PolicyBlockChoice[] = PERMISSION_MODES.map((mode) => ({ value: mode, label: PERMISSION_MODE_LABELS[mode] }))
const RETENTION_CHOICES: readonly PolicyBlockChoice[] = [7, 30, 90, 365].map((count) => ({ value: String(count), label: `${count} days` }))
const RATE_LIMIT_BEHAVIORS = ['ask', 'queue', 'continue', 'stop'] as const
const REMOTE_ACCESS_MODES = ['off', 'private', 'any'] as const
const UPDATE_MODES = ['auto', 'off'] as const

/** `value` as one of `list`, or undefined. */
function oneOf<T extends string>(list: readonly T[], value: string | undefined): T | undefined {
  return list.find((item) => item === value)
}

function onOffValue(value: boolean | undefined): string | undefined {
  return value === undefined ? undefined : value ? 'on' : 'off'
}

function onOffFlag(value: string | undefined): boolean | undefined {
  return value === undefined ? undefined : value === 'on'
}

/** An object with no set key is left out of the document. */
function unlessEmpty<T extends object>(value: T): T | undefined {
  return Object.values(value).some((child) => child !== undefined) ? value : undefined
}

function withHost(document: PolicyDocument, patch: ManagedHostSettings): PolicyDocument {
  return { ...document, host: unlessEmpty({ ...document.host, ...patch }) }
}

function withLimits(document: PolicyDocument, patch: Partial<SessionLimits>): PolicyDocument {
  const sessions = { ...document.sessions, limits: unlessEmpty({ ...document.sessions?.limits, ...patch }) }
  return { ...document, sessions: unlessEmpty(sessions) }
}

function withSettings(document: PolicyDocument, patch: ManagedSessionSettings): PolicyDocument {
  const sessions = { ...document.sessions, settings: unlessEmpty({ ...document.sessions?.settings, ...patch }) }
  return { ...document, sessions: unlessEmpty(sessions) }
}

function hostSwitch(id: 'trustLocalNetwork' | 'cloudTunnel' | 'previewTunnelEnabled' | 'analyticsEnabled' | 'continueSessionsAfterHostRestart', label: string, description: string, initial: 'on' | 'off'): PolicyBlock {
  return {
    id,
    label,
    description,
    group: 'Host settings',
    choices: ON_OFF,
    initial,
    read: (document) => onOffValue(document.host?.[id]),
    write: (document, value) => withHost(document, { [id]: onOffFlag(value) }),
  }
}

function retention(id: 'archivedAutomationRetentionDays' | 'unfiledRecordingRetentionDays', label: string, description: string): PolicyBlock {
  return {
    id,
    label,
    description,
    group: 'Host settings',
    choices: RETENTION_CHOICES,
    initial: '30',
    read: (document) => {
      const days = document.host?.[id]
      return days === undefined ? undefined : String(days)
    },
    write: (document, value) => withHost(document, { [id]: value === undefined ? undefined : Number(value) }),
  }
}

const ALLOWED_AGENT_CHOICES: readonly PolicyBlockChoice[] = [
  { value: 'claude-code', label: 'Claude only' },
  { value: 'codex', label: 'Codex only' },
  { value: 'claude-code,codex', label: 'Claude and Codex' },
]

function allowedAgents(value: string | undefined): SessionLimits['providers'] {
  const ids = (value ?? '').split(',').flatMap((id) => oneOf(POLICY_PROVIDER_IDS, id) ?? [])
  const [first, ...rest] = ids
  return first ? { allowed: [first, ...rest] } : undefined
}

export const POLICY_BLOCKS: readonly PolicyBlock[] = [
  {
    id: 'maxPermissionMode',
    label: 'Highest permission mode',
    description: 'Sessions cannot run in a mode above this one.',
    group: 'Session limits',
    choices: MODE_CHOICES,
    initial: 'auto',
    read: (document) => document.sessions?.limits?.maxPermissionMode,
    write: (document, value) => withLimits(document, { maxPermissionMode: oneOf(PERMISSION_MODES, value) }),
  },
  {
    id: 'allowedAgents',
    label: 'Allowed agents',
    description: 'The agents that sessions may run.',
    group: 'Session limits',
    choices: ALLOWED_AGENT_CHOICES,
    initial: 'claude-code,codex',
    read: (document) => document.sessions?.limits?.providers?.allowed?.join(','),
    write: (document, value) => {
      const providers = unlessEmpty({ ...document.sessions?.limits?.providers, allowed: allowedAgents(value)?.allowed })
      return withLimits(document, { providers })
    },
  },
  {
    id: 'sessionCloudSync',
    label: 'Cloud copy of sessions',
    description: 'Off: no conversation leaves its host.',
    group: 'Session limits',
    choices: ON_OFF,
    initial: 'off',
    read: (document) => onOffValue(document.sessions?.limits?.sessionCloudSync),
    write: (document, value) => withLimits(document, { sessionCloudSync: onOffFlag(value) }),
  },
  {
    id: 'insights',
    label: 'Send all Insights',
    description: 'Send the Insights of every session to the organization.',
    group: 'Session limits',
    choices: ON_OFF,
    initial: 'on',
    read: (document) => onOffValue(document.sessions?.limits?.insights?.syncAll),
    write: (document, value) => withLimits(document, { insights: value === undefined ? undefined : { syncAll: value === 'on' } }),
  },
  {
    id: 'webhooks',
    label: 'Unverified webhooks',
    description: 'Whether a webhook without a signature can start work.',
    group: 'Session limits',
    choices: [{ value: 'on', label: 'Allowed' }, { value: 'off', label: 'Not allowed' }],
    initial: 'off',
    read: (document) => onOffValue(document.sessions?.limits?.webhooks?.allowUnverified),
    write: (document, value) => withLimits(document, { webhooks: value === undefined ? undefined : { allowUnverified: value === 'on' } }),
  },
  {
    id: 'defaultPermissionMode',
    label: 'Default permission mode',
    description: 'The mode a new session starts in. People cannot change it.',
    group: 'Session defaults',
    choices: MODE_CHOICES,
    initial: 'supervised',
    read: (document) => document.sessions?.settings?.defaultPermissionMode,
    write: (document, value) => withSettings(document, { defaultPermissionMode: oneOf(PERMISSION_MODES, value) }),
  },
  {
    id: 'rateLimitBehavior',
    label: 'At a rate limit',
    description: 'What a session does when its provider is out of usage.',
    group: 'Session defaults',
    choices: [
      { value: 'ask', label: 'Ask' },
      { value: 'queue', label: 'Wait for the reset' },
      { value: 'continue', label: 'Continue' },
      { value: 'stop', label: 'Stop' },
    ],
    initial: 'ask',
    read: (document) => document.sessions?.settings?.rateLimitBehavior,
    write: (document, value) => withSettings(document, { rateLimitBehavior: oneOf(RATE_LIMIT_BEHAVIORS, value) }),
  },
  {
    id: 'remoteAccess',
    label: 'Remote access',
    description: 'Which networks can reach the host.',
    group: 'Host settings',
    choices: [{ value: 'off', label: 'Off' }, { value: 'private', label: 'Private networks only' }, { value: 'any', label: 'Any network' }],
    initial: 'private',
    read: (document) => {
      const value = document.host?.remoteAccess
      return value === true ? 'any' : value === false ? 'off' : value
    },
    write: (document, value) => withHost(document, { remoteAccess: oneOf(REMOTE_ACCESS_MODES, value) }),
  },
  hostSwitch('trustLocalNetwork', 'Trust the local network', 'Devices on the local network connect without pairing.', 'off'),
  hostSwitch('cloudTunnel', 'Solus Cloud link', 'Off: the host makes no tunnel to Solus Cloud.', 'off'),
  hostSwitch('previewTunnelEnabled', 'Preview tunnel', 'Clients can open the preview ports of the host.', 'off'),
  hostSwitch('analyticsEnabled', 'Analytics', 'Usage analytics of Solus on the host.', 'off'),
  hostSwitch('continueSessionsAfterHostRestart', 'Continue sessions after a restart', 'Sessions that ran when the host stopped continue when it starts.', 'on'),
  {
    id: 'updates',
    label: 'Solus updates',
    description: 'Off: the desktop app does not update itself.',
    group: 'Host settings',
    choices: [{ value: 'auto', label: 'Automatic' }, { value: 'off', label: 'Off' }],
    initial: 'auto',
    read: (document) => document.host?.updates?.mode,
    write: (document, value) => {
      const mode = oneOf(UPDATE_MODES, value)
      return withHost(document, { updates: mode ? { ...document.host?.updates, mode } : undefined })
    },
  },
  retention('archivedAutomationRetentionDays', 'Keep archived automations', 'How long the host keeps an archived automation.'),
  retention('unfiledRecordingRetentionDays', 'Keep unfiled recordings', 'How long the host keeps a recording that is not filed.'),
]

/** The blocks a document of `kind` can hold: an organization policy has no host settings. */
export function policyBlocksFor(kind: PolicyKind): PolicyBlock[] {
  return POLICY_BLOCKS.filter((block) => kind !== 'organization' || block.group !== 'Host settings')
}

/**
 * The editor's text as a document the blocks can change. Only its shape is
 * checked, so a rule that conflicts with another (a default mode above the
 * highest) can still be changed with a block; the editor shows the conflict.
 */
export function blockDocument(text: string): PolicyDocument | null {
  try {
    const parsed = policyDocumentFields.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** The text with one block set to `value`, or removed when `value` is undefined. */
export function applyPolicyBlock(document: PolicyDocument, block: PolicyBlock, value: string | undefined): string {
  return policyText(block.write(document, value))
}
