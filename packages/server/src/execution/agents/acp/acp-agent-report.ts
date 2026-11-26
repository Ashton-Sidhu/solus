import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { MODEL_PROFILES, reasoningEffortSchema, type AgentId, type AgentSlashCommand, type ModelProfile, type ReasoningEffort } from '@solus/contracts/types'
import { createLogger } from '../../../logger'
import type { AcpSessionSetupResult } from './acp-protocol'

const log = createLogger('AcpAgentReport', 'acp-agent-report.ts')

/** A model the agent offers this account: the `model` option of `session/new`. */
export interface ReportedModel {
  id: string
  label: string
  /** The efforts the agent offers for the model, least first. Absent: the agent did not say. */
  reasoningLevels?: ReasoningEffort[]
}

const reportSchema = z.object({
  commands: z.array(z.object({ name: z.string(), description: z.string(), argumentHint: z.string().optional() })).catch([]),
  models: z.array(z.object({ id: z.string(), label: z.string(), reasoningLevels: z.array(reasoningEffortSchema).optional() })).catch([]),
})

const selectOptionSchema = z.object({ value: z.string(), name: z.string().optional() })
const optionGroupSchema = z.object({ options: z.array(selectOptionSchema) })

/** The context window of a model the published list does not know: the provider's default model's. */
const FALLBACK_CONTEXT_WINDOW = 1_000_000

/**
 * The models a session's `model` option offers; empty when the agent sent no
 * such option. A model's efforts come from `models.availableModels`, which
 * names each as its own id (`gemini-4-neon-low`): the `thought_level` option
 * gives them only for the selected model.
 */
export function modelsOffered(setup: Pick<AcpSessionSetupResult, 'configOptions' | 'models'>): ReportedModel[] {
  const option = setup.configOptions?.find((candidate) => candidate.id === 'model')
  const variants = setup.models?.availableModels.map((model) => model.modelId)
  return (option?.options ?? []).flatMap((entry) => {
    const one = selectOptionSchema.safeParse(entry)
    const entries = one.success ? [one.data] : optionGroupSchema.safeParse(entry).data?.options ?? []
    return entries.map((choice): ReportedModel => {
      const model: ReportedModel = { id: choice.value, label: choice.name?.trim() || choice.value }
      if (variants) model.reasoningLevels = reasoningEffortSchema.options.filter((effort) => variants.includes(`${choice.value}-${effort}`))
      return model
    })
  })
}

/**
 * What an ACP agent reports about itself when a session opens: its commands
 * (`available_commands_update`) and the models it offers the account. agy
 * reports both only then, and starting it to ask costs a 1 GB unpack, so the
 * host keeps the last report in a file.
 */
export class AcpAgentReport {
  private report: z.infer<typeof reportSchema>

  constructor(private readonly agentId: AgentId, private readonly file: string) {
    this.report = AcpAgentReport.read(file)
  }

  private static read(file: string): z.infer<typeof reportSchema> {
    try {
      return reportSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
    } catch {
      return { commands: [], models: [] }
    }
  }

  get commands(): AgentSlashCommand[] {
    return this.report.commands
  }

  keepCommands(commands: AgentSlashCommand[]): void {
    if (JSON.stringify(commands) === JSON.stringify(this.report.commands)) return
    this.report.commands = commands
    this.write()
  }

  /** The efforts the agent reported for a model; undefined when it did not report them. */
  reasoningLevelsOf(modelId: string): ReasoningEffort[] | undefined {
    return this.report.models.find((model) => model.id === modelId)?.reasoningLevels
  }

  /** Keeps the models a session offered; true when they changed. */
  keepModels(models: ReportedModel[]): boolean {
    if (models.length === 0 || JSON.stringify(models) === JSON.stringify(this.report.models)) return false
    this.report.models = models
    this.write()
    return true
  }

  /**
   * The models the agent offered this account, in its order, each with a profile: the published
   * one when the list knows the model (its label, legacy flag, and default), else a plain one under
   * the agent's own label. The efforts are the agent's when it reported them, else the published
   * ones. Empty until a session has opened.
   */
  offeredModels(): Array<{ id: string; profile: ModelProfile }> {
    const listed = MODEL_PROFILES[this.agentId] ?? {}
    const fallback = Object.values(listed).find((profile) => profile.isDefault)
    return this.report.models.map((model) => {
      const published = listed[model.id]
      const profile: ModelProfile = published ? { ...published } : {
        label: model.label,
        reasoningLevels: [],
        defaultReasoningEffort: 'medium',
        supportsFastMode: false,
        contextWindows: [fallback?.defaultContextWindow ?? FALLBACK_CONTEXT_WINDOW],
        defaultContextWindow: fallback?.defaultContextWindow ?? FALLBACK_CONTEXT_WINDOW,
      }
      const levels = model.reasoningLevels
      if (levels?.length) {
        profile.reasoningLevels = levels
        if (!levels.includes(profile.defaultReasoningEffort)) profile.defaultReasoningEffort = levels.includes('medium') ? 'medium' : levels[0]!
      }
      return { id: model.id, profile }
    })
  }

  private write(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.report))
    } catch (error) {
      log.warn('acp_report_write_failed', { provider: this.agentId, error: error instanceof Error ? error.message : String(error) })
    }
  }
}
