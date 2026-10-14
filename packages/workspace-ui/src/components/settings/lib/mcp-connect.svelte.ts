import type { Integration } from '@solus/contracts/integration-types'
import { SvelteSet } from 'svelte/reactivity'
import { integrationsStore } from '../integrations.store.svelte'
import { connectStep, type ConnectStep } from './integration-labels'
import type { McpCatalog } from './mcp-catalog.svelte'

/** What the connect dialog opens for: a server on the host, or a catalog entry to add first. */
export interface ConnectRequest {
  name: string
  url: string
  icon?: string
  integrationId?: string
}

/**
 * One run of the connect dialog (docs/integrations.md): add the server when it
 * is new, sign in, then choose the tools agents may use. The choice is a draft
 * until Connect saves it. Closing before the end takes back what this run
 * added, so Cancel leaves the host as it was. Ephemeral: it lives as long as
 * the dialog.
 */
export class McpConnect {
  integrationId = $state<string | null>(null)
  /** The tools the person turned off in this dialog. */
  readonly disabledDraft = new SvelteSet<string>()
  isDone = $state(false)
  isSaving = $state(false)
  saveError = $state('')
  private addedHere = false

  constructor(
    private readonly serverId: string,
    readonly request: ConnectRequest,
    private readonly catalog: McpCatalog,
  ) {
    this.integrationId = request.integrationId ?? null
    if (this.integration) this.seedDraft(this.integration)
  }

  get integration(): Integration | null {
    const id = this.integrationId
    return id ? integrationsStore.states.get(this.serverId)?.integrations?.find((item) => item.id === id) ?? null : null
  }

  get step(): ConnectStep {
    const integration = this.integration
    return connectStep(integration?.auth ?? null, integration ? integrationsStore.connection(this.serverId, integration.id) : null)
  }

  /** The reason the last Add stopped, while no record exists. */
  get addError(): string {
    const state = this.catalog.installs.get(this.request.url)
    return !this.integrationId && state?.kind === 'failed' ? state.message : ''
  }

  get isAdding(): boolean {
    const state = this.catalog.installs.get(this.request.url)
    return !this.integrationId && !!state && state.kind !== 'failed'
  }

  /** Adds the server when the dialog opened for a catalog entry. */
  async start(): Promise<void> {
    if (this.integrationId) return
    const integration = await this.catalog.install(this.request.name, this.request.url)
    if (!integration) return
    this.addedHere = true
    this.integrationId = integration.id
    this.seedDraft(integration)
  }

  setTool(toolName: string, isOn: boolean): void {
    if (isOn) this.disabledDraft.delete(toolName)
    else this.disabledDraft.add(toolName)
  }

  /** Saves the tools that are off; the dialog then says what is ready. */
  async finish(): Promise<void> {
    const integration = this.integration
    if (!integration || this.isSaving) return
    this.isSaving = true
    this.saveError = ''
    const saved = await integrationsStore.update(this.serverId, { id: integration.id, disabledTools: [...this.disabledDraft] })
    this.isSaving = false
    if (!saved) {
      this.saveError = integrationsStore.states.get(this.serverId)?.writeError || 'Could not save the tools. Try again.'
      integrationsStore.clearWriteError(this.serverId)
      return
    }
    this.addedHere = false
    this.isDone = true
  }

  /** Ends a sign-in that runs, and removes the server when this run added it and did not finish. */
  async dismiss(): Promise<void> {
    if (this.isDone) return
    const id = this.integrationId
    if (!id) {
      this.catalog.dismiss(this.request.url)
      return
    }
    const flow = integrationsStore.connectFlow(this.serverId, id)
    if (flow && flow.kind !== 'failed') await integrationsStore.cancel(this.serverId, id)
    if (this.addedHere) await integrationsStore.remove(this.serverId, id)
  }

  private seedDraft(integration: Integration): void {
    this.disabledDraft.clear()
    for (const name of integration.disabledTools) this.disabledDraft.add(name)
  }
}
