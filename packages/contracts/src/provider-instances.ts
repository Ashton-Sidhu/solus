import { z } from 'zod'

const effortSchema = z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode'])

export const instanceProviderSchema = z.enum(['claude-code', 'codex'])
export type InstanceProvider = z.infer<typeof instanceProviderSchema>
export const providerInstanceIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/)
const text = z.string().max(4096).refine((value) => !value.includes('\0'), 'A path cannot contain a null character.')
export const instanceEnvironmentSchema = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).refine((name) => !['HOME', 'USERPROFILE', 'USER', 'LOGNAME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'].includes(name), 'Use the Runtime home fields instead of overriding the acting identity.'),
  value: z.string().max(16384).refine((value) => !value.includes('\0'), 'Environment values cannot contain null characters.'),
  sensitive: z.boolean(),
  configured: z.boolean().optional(),
}).strict()
export const customProviderModelSchema = z.object({
  id: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(200),
  reasoningLevels: z.array(effortSchema).min(1).max(16),
  defaultReasoningEffort: effortSchema,
  contextWindows: z.array(z.number().int().positive().max(100_000_000)).min(1).max(16),
  defaultContextWindow: z.number().int().positive().max(100_000_000),
  supportsFastMode: z.boolean(),
}).strict()
export type CustomProviderModel = z.infer<typeof customProviderModelSchema>

export const providerInstanceSchema = z.object({
  id: providerInstanceIdSchema,
  provider: instanceProviderSchema,
  displayName: z.string().trim().min(1).max(120),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
  enabled: z.boolean(),
  // Accepted for stored documents and older hosts; model defaults belong to personal settings.
  defaultModel: z.string().max(200).nullable().default(null),
  binaryPath: text,
  homePath: text,
  shadowHomePath: text,
  launchArgs: z.array(z.string().max(4096).refine((value) => !value.includes('\0'), 'Arguments cannot contain null characters.')).max(100),
  environment: z.array(instanceEnvironmentSchema).max(100),
  autoCompactWindow: z.number().int().min(100_000).max(1_000_000).nullable(),
  idleCompaction: z.enum(['default', 'onReturn', 'off']),
  customModels: z.array(customProviderModelSchema).max(100),
  hiddenModels: z.array(z.string().max(200)).max(500),
  favoriteModels: z.array(z.string().max(200)).max(500),
  modelOrder: z.array(z.string().max(200)).max(500),
}).strict().superRefine((instance, context) => {
  const models = new Set<string>()
  for (const model of instance.customModels) {
    if (models.has(model.id)) context.addIssue({ code: 'custom', message: `Duplicate custom model: ${model.id}` })
    models.add(model.id)
    if (!model.reasoningLevels.includes(model.defaultReasoningEffort) || !model.contextWindows.includes(model.defaultContextWindow)) context.addIssue({ code: 'custom', message: `The defaults for ${model.id} must be in its supported options.` })
    if (instance.provider === 'claude-code' && model.supportsFastMode) context.addIssue({ code: 'custom', message: 'Solus fast mode is supported by Codex only.' })
  }
  for (const argument of instance.launchArgs) {
    const name = argument.split('=')[0]
    if (['--listen', '--input-format', '--output-format', '--resume', '--session-id'].includes(name ?? '')) context.addIssue({ code: 'custom', message: `Solus owns the ${name} argument.` })
  }
  const names = new Set<string>()
  for (const variable of instance.environment) {
    if (names.has(variable.name)) context.addIssue({ code: 'custom', message: `Duplicate environment variable: ${variable.name}` })
    names.add(variable.name)
  }
  if (instance.provider === 'codex' && instance.autoCompactWindow !== null) context.addIssue({ code: 'custom', message: 'Auto-compaction thresholds belong to Claude Code.' })
})
export type ProviderInstance = z.infer<typeof providerInstanceSchema>

export const providerProjectOverrideSchema = z.object({
  projectRoot: text.min(1),
  enabled: z.record(providerInstanceIdSchema, z.boolean()),
  selected: z.object({ 'claude-code': providerInstanceIdSchema.optional(), codex: providerInstanceIdSchema.optional() }).strict(),
}).strict()
export type ProviderProjectOverride = z.infer<typeof providerProjectOverrideSchema>
export type ProviderInstanceChoice = Pick<ProviderInstance, 'id' | 'provider' | 'displayName' | 'enabled' | 'customModels' | 'hiddenModels' | 'favoriteModels' | 'modelOrder'> & { binaryAvailable: boolean }
export interface ProviderInstancePreferences {
  selected: string
  instances: ProviderInstanceChoice[]
  projects: ProviderProjectOverride[]
}

export const providerInstancesSnapshotSchema = z.object({
  configurationVersion: z.literal(2).optional(),
  projects: z.array(providerProjectOverrideSchema).max(1000).default([]),
  revision: z.number().int().nonnegative(),
  instances: z.array(providerInstanceSchema).max(50),
  selected: z.object({ 'claude-code': providerInstanceIdSchema, codex: providerInstanceIdSchema }).strict(),
  healthCheckSeconds: z.number().int().min(0).max(86400),
  idleCompaction: z.enum(['onReturn', 'off']),
}).strict()
export type ProviderInstancesSnapshot = z.infer<typeof providerInstancesSnapshotSchema>
export const providerInstancesWriteSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  change: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('save'), instance: providerInstanceSchema }).strict(),
    z.object({ kind: z.literal('project'), override: providerProjectOverrideSchema }).strict(),
    z.object({ kind: z.literal('remove'), instanceId: providerInstanceIdSchema }).strict(),
    z.object({ kind: z.literal('select'), instanceId: providerInstanceIdSchema }).strict(),
    z.object({ kind: z.literal('advanced'), healthCheckSeconds: z.number().int().min(0).max(86400), idleCompaction: z.enum(['onReturn', 'off']) }).strict(),
  ]),
}).strict()
export type ProviderInstancesWrite = z.input<typeof providerInstancesWriteSchema>

export function newProviderInstance(provider: InstanceProvider, id: string, displayName: string): ProviderInstance {
  return {
    id, provider, displayName, accentColor: null, enabled: true, defaultModel: null, binaryPath: '', homePath: '', shadowHomePath: '',
    launchArgs: [], environment: [], autoCompactWindow: null, idleCompaction: 'default',
    customModels: [], hiddenModels: [], favoriteModels: [], modelOrder: [],
  }
}

export const providerInstanceTargetSchema = z.object({ instanceId: providerInstanceIdSchema }).strict()
export type ProviderInstanceTarget = z.infer<typeof providerInstanceTargetSchema>
export const providerInstanceCodeSchema = providerInstanceTargetSchema.extend({ code: z.string().min(1).max(8192) }).strict()
export type ProviderInstanceCode = z.infer<typeof providerInstanceCodeSchema>
export interface ProviderInstanceStatus {
  instanceId: string
  checkedAt: number
  version: string | null
  authenticated: boolean
  account: string | null
  phase: 'idle' | 'connecting' | 'connected' | 'failed'
  error: string | null
}
