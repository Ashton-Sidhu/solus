import { managedSettingLines } from '@solus/client-core/policy'
import type { HostPolicies } from '@solus/contracts/host-policies'
import type { ManagedSessionSettingKey, ManagedSessionSettings } from '@solus/contracts/policy'
import { AGENT_LABELS, MODEL_PROFILES, type AgentId } from '@solus/contracts/types'
import { PERMISSION_MODE_DISPLAY } from '../../../../lib/permission-modes'

/** What a settings row shows for a managed key (plans/030 §7): one line per organization that locks it. */
export interface ManagedSettingNote {
  /** The MDM policy locks the key for all work on this host: the control is disabled. */
  lockedEverywhere: boolean
  lines: string[]
}

type ManagedValue<K extends ManagedSessionSettingKey> = Exclude<ManagedSessionSettings[K], undefined>

function modelName(provider: AgentId, model: string): string {
  return MODEL_PROFILES[provider]?.[model]?.label ?? model
}


const RATE_LIMIT_BEHAVIOR = {
  ask: 'ask at a rate limit',
  queue: 'wait for the rate limit to reset',
  continue: 'stop at a rate limit',
  stop: 'stop at a rate limit',
} satisfies Record<ManagedValue<'rateLimitBehavior'>, string>

/** How each managed value reads in "Globex sessions use <value> (managed)." */
type ManagedValueDescriptions = { [K in ManagedSessionSettingKey]: (value: ManagedValue<K>) => string }

const DESCRIBE: ManagedValueDescriptions = {
  workerModel: (value) => (value ? modelName(value.provider, value.model) : 'the caller\'s model by default'),
  fallbackModel: (value) => (value ? `${modelName(value.provider, value.model)} while the default provider is out of usage` : 'no fallback model'),
  modelRouting: () => 'a set model routing',
  textGenerationModel: (value) => modelName(value.provider, value.model),
  sourceControlWriterModel: (value) => (value ? modelName(value.provider, value.model) : 'the text-generation model for commits'),
  extraInstructions: () => 'set custom instructions',
  modelInstructions: () => 'set model instructions',
  delegationInstructions: () => 'set delegation instructions',
  sourceControlWriting: () => 'a set writing style for commits and pull requests',
  worktreeBranchNaming: () => 'a set branch name format',
  codebaseNaming: (value) => value === 'generated' ? 'generated codebase names' : 'codebase names from the folder names',
  defaultPermissionMode: (value) => `${PERMISSION_MODE_DISPLAY[value].label} by default`,
  rateLimitBehavior: (value) => RATE_LIMIT_BEHAVIOR[value],
  reviewAgent: (value) => `${AGENT_LABELS[value]} for reviews`,
  reviewModel: (value) => `${value} for reviews`,
  reviewGuideInstructions: () => 'set review guide instructions',
}

export function managedSettingNote<K extends ManagedSessionSettingKey>(
  policies: HostPolicies,
  organizations: readonly { organizationId: string; name: string }[],
  key: K,
): ManagedSettingNote {
  return managedSettingLines(policies, organizations, key, DESCRIBE[key])
}
