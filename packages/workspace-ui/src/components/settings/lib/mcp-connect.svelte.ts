import type { Integration } from '@solus/contracts/integration-types'
import { IntegrationSignIn } from '@solus/contracts/integrations/integration-sign-in'
import { SetupHandoff, type IntegrationSetupNeed } from '@solus/contracts/integrations/setup-handoff'
import { SvelteSet } from 'svelte/reactivity'
import { integrationsStore } from '../integrations.store.svelte'
import { IntegrationLabels, type ConnectStep } from './integration-labels'
import type { McpCatalog } from './mcp-catalog.svelte'
import { envNamesOf, McpCommandForm } from './mcp-command.svelte'

/** What the connect dialog opens for: a server on the host, or a catalog entry to add first. */
export interface ConnectRequest {
  name: string
  url: string
  icon?: string
  integrationId?: string
  /** The vendor's setup page, from a Solus catalog entry (§13.5). */
  authHelp?: string
  /**
   * Add a command (docs/plans/mcp-first-class.md §7.7): the first step is
   * its form and Start and test, in place of the sign-in. `name` and `url` are empty.
   */
  isCommand?: boolean
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
  /** The form of a command; null for a server at an address. */
  readonly command: McpCommandForm | null
  /** The command started and listed its tools: the dialog goes on to them. */
  isCommandStarted = $state(false)
  private addedHere = false

  constructor(
    private readonly serverId: string,
    readonly request: ConnectRequest,
    private readonly catalog: McpCatalog,
    mayRunCommands: () => boolean = () => true,
  ) {
    this.integrationId = request.integrationId ?? null
    this.command = request.isCommand ? new McpCommandForm(serverId, mayRunCommands) : null
    if (this.integration) this.seedDraft(this.integration)
  }

  get integration(): Integration | null {
    const id = this.integrationId
    return id ? integrationsStore.states.get(this.serverId)?.integrations?.find((item) => item.id === id) ?? null : null
  }

  get step(): ConnectStep {
    if (this.command && !this.isCommandStarted) return 'command'
    const integration = this.integration
    return integration ? new IntegrationLabels(integration).connectStep(integrationsStore.connection(this.serverId, integration.id)) : 'adding'
  }

  /** The reason the last Add stopped, while no record exists. */
  get addError(): string {
    const state = this.catalog.installs.get(this.request.url)
    return !this.integrationId && state?.kind === 'failed' ? state.message : ''
  }

  /**
   * What the person must set up at the vendor before Solus can connect, for
   * "Set up with an agent" (docs/plans/mcp-integrations.md §13.4): from the
   * refused probe while no record exists, else from the record's auth until
   * the person is connected.
   */
  get setupHandoff(): SetupHandoff | null {
    const need = this.setupNeed
    if (!need) return null
    return new SetupHandoff(need, {
      name: this.integration?.name ?? this.request.name,
      url: this.integration?.url ?? this.request.url,
      callbackUrl: need === 'oauth-client' ? integrationsStore.oauthRedirectUrl(this.serverId) : undefined,
      guideUrl: this.request.authHelp,
    })
  }

  private get setupNeed(): IntegrationSetupNeed | null {
    const integration = this.integration
    if (!integration) {
      const state = this.catalog.installs.get(this.request.url)
      return state?.kind === 'failed' ? state.setupNeed ?? null : null
    }
    return new IntegrationSignIn(integration).setupNeedFor(integrationsStore.connection(this.serverId, integration.id))
  }

  /**
   * Hand the setup to an agent: keep a server this run added, so the person
   * finds it waiting in Settings, and close. The caller opens the conversation.
   */
  keepForHandoff(): void {
    this.addedHere = false
  }

  get isAdding(): boolean {
    const state = this.catalog.installs.get(this.request.url)
    return !this.integrationId && !!state && state.kind !== 'failed'
  }

  /** A save, the values, or the start of the command runs. */
  get isStartingCommand(): boolean {
    const id = this.integrationId
    return !!this.command?.isSaving || this.isSendingValues || (!!id && !!this.processes?.isStarting(id))
  }

  private isSendingValues = $state(false)

  private get processes() {
    return integrationsStore.states.get(this.serverId)?.processes
  }

  /**
   * Start and test (§7.7): add the command, or save its changes, hand over the
   * values the person typed, then start it and list its tools. A step that
   * fails leaves the form open with the reason; the record stays until the
   * dialog closes, and the next try changes it.
   */
  async startCommand(): Promise<void> {
    const form = this.command
    if (!form || this.isStartingCommand) return
    const integration = await form.save(this.integration)
    if (!integration) return
    if (!this.integrationId) {
      this.addedHere = true
      this.integrationId = integration.id
    }
    const values = form.takeValues()
    const hasValues = integrationsStore.connection(this.serverId, integration.id)?.status === 'connected'
    if (values) {
      this.isSendingValues = true
      const saved = await integrationsStore.submitValues(this.serverId, integration.id, values)
      this.isSendingValues = false
      if (!saved) {
        const flow = integrationsStore.connectFlow(this.serverId, integration.id)
        form.problem = { field: 'envNames', reason: flow?.kind === 'values' && flow.error ? flow.error : 'The host did not save the values.' }
        await integrationsStore.cancel(this.serverId, integration.id)
        return
      }
    } else if (envNamesOf(integration).length > 0 && !hasValues) {
      form.problem = { field: 'envNames', reason: 'Enter a value for each environment variable.' }
      return
    }
    if (await this.processes?.start(integration.id)) {
      this.isCommandStarted = true
      this.seedDraft(integration)
    }
  }

  /** Cancel of a start that runs: the host stops the process (§7.7). */
  async cancelCommandStart(): Promise<void> {
    if (this.integrationId) await this.processes?.stop(this.integrationId)
  }

  /** Adds the server when the dialog opened for a catalog entry. */
  async start(): Promise<void> {
    if (this.integrationId || this.command) return
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
      if (!this.command) this.catalog.dismiss(this.request.url)
      return
    }
    // Remove stops the process too; a command kept stops only a start that runs.
    if (this.command && !this.addedHere && this.processes?.isStarting(id)) await this.processes.stop(id)
    const flow = integrationsStore.connectFlow(this.serverId, id)
    if (flow && flow.kind !== 'failed') await integrationsStore.cancel(this.serverId, id)
    if (this.addedHere) await integrationsStore.remove(this.serverId, id)
  }

  private seedDraft(integration: Integration): void {
    this.disabledDraft.clear()
    for (const name of integration.disabledTools) this.disabledDraft.add(name)
  }
}
