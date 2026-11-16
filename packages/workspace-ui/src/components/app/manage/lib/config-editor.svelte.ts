import type { AppConfigState } from '@solus/contracts/apps'
import { appsStore } from '../../../../contexts/apps/apps.store.svelte'
import { toasts } from '../../../../lib/toasts'
import { analyzeConfigDocument, configDocumentText, type ConfigAnalysis } from './config-document'

/**
 * What the owner does in the Config section's editor (docs/plans/apps.md
 * §4.4): an edit of the config document, Discard, and Save. With no edit, the
 * document is the saved config and follows it when it changes. Save sends one
 * `appConfigSet` for each changed field — null gives a field its default
 * again — and only when the document has no problem.
 */
export class ConfigEditor {
  /** What the owner wrote; null while the editor shows the saved config. */
  draft = $state<string | null>(null)
  isSaving = $state(false)

  constructor(private readonly target: () => { serverId: string; appId: string; config: readonly AppConfigState[] }) {}

  get savedText(): string {
    return configDocumentText(this.target().config)
  }

  get text(): string {
    return this.draft ?? this.savedText
  }

  get isEdited(): boolean {
    return this.draft !== null && this.draft !== this.savedText
  }

  get analysis(): ConfigAnalysis {
    return analyzeConfigDocument(this.text, this.target().config)
  }

  /** Save sends the changes: there is one, there is no problem, and no save runs. */
  get canSave(): boolean {
    const analysis = this.analysis
    return !this.isSaving && analysis.problems.length === 0 && analysis.changes.length > 0
  }

  edit(text: string): void {
    this.draft = text === this.savedText ? null : text
  }

  discard(): void {
    this.draft = null
  }

  /** The document with every field at its default. Save sends it. */
  resetAll(): void {
    this.edit(configDocumentText(this.target().config, 'default'))
  }

  /**
   * Sends each change, one after the other: each answer is the whole state of
   * the app, so a later answer is never replaced by an earlier one. A change
   * that fails stops the save; what was sent stays saved, and the draft stays
   * so the owner sees what did not save.
   */
  async save(): Promise<boolean> {
    if (!this.canSave) return false
    const { serverId, appId } = this.target()
    const changes = this.analysis.changes
    this.isSaving = true
    try {
      for (const change of changes) await appsStore.setConfig(serverId, appId, change.field.name, change.value)
      this.draft = null
      return true
    } catch (error) {
      toasts.error('The config was not saved', { description: error instanceof Error ? error.message : String(error) })
      return false
    } finally {
      this.isSaving = false
    }
  }
}
