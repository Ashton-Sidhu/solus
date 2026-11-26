import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { MODEL_PROFILES, type AgentId, type AgentSlashCommand, type ModelProfile } from '@solus/contracts/types'
import { createLogger } from '../../../logger'
import type { AcpConfigOption } from './acp-protocol'

const log = createLogger('AcpAgentReport', 'acp-agent-report.ts')

/** A model the agent offers this account: the `model` option of `session/new`. */
export interface ReportedModel {
  id: string
  label: string
}

const reportSchema = z.object({
  commands: z.array(z.object({ name: z.string(), description: z.string(), argumentHint: z.string().optional() })).catch([]),
  models: z.array(z.object({ id: z.string(), label: z.string() })).catch([]),
})

const selectOptionSchema = z.object({ value: z.string(), name: z.string().optional() })
const optionGroupSchema = z.object({ options: z.array(selectOptionSchema) })

/** The context window of a model the published list does not know: the provider's default model's. */
const FALLBACK_CONTEXT_WINDOW = 1_000_000

/** The models a session's `model` option offers; empty when the agent sent no such option. */
export function modelsOffered(configOptions: AcpConfigOption[]): ReportedModel[] {
  const option = configOptions.find((candidate) => candidate.id === 'model')
  return (option?.options ?? []).flatMap((entry) => {
    const one = selectOptionSchema.safeParse(entry)
    const entries = one.success ? [one.data] : optionGroupSchema.safeParse(entry).data?.options ?? []
    return entries.map((choice) => ({ id: choice.value, label: choice.name?.trim() || choice.value }))
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

  /** Keeps the models a session offered; true when the models outside the published list changed. */
  keepModels(models: ReportedModel[]): boolean {
    if (models.length === 0 || JSON.stringify(models) === JSON.stringify(this.report.models)) return false
    const before = JSON.stringify(this.unlistedModels())
    this.report.models = models
    this.write()
    return JSON.stringify(this.unlistedModels()) !== before
  }

  /** The offered models the published list does not know, with a profile each: the list stays authoritative. */
  unlistedModels(): Array<ReportedModel & { profile: ModelProfile }> {
    const listed = MODEL_PROFILES[this.agentId] ?? {}
    const fallback = Object.values(listed).find((profile) => profile.isDefault)
    return this.report.models.filter((model) => !listed[model.id]).map((model) => ({
      ...model,
      profile: {
        label: model.label,
        reasoningLevels: [],
        defaultReasoningEffort: 'medium',
        supportsFastMode: false,
        contextWindows: [fallback?.defaultContextWindow ?? FALLBACK_CONTEXT_WINDOW],
        defaultContextWindow: fallback?.defaultContextWindow ?? FALLBACK_CONTEXT_WINDOW,
      },
    }))
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
