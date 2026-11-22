import type { Integration, IntegrationAuthChoice, IntegrationEnvValue } from '@solus/contracts/integration-types'
import { IntegrationSignIn } from '@solus/contracts/integrations/integration-sign-in'
import { SetupHandoff, type IntegrationSetupNeed } from '@solus/contracts/integrations/setup-handoff'
import { SvelteSet } from 'svelte/reactivity'
import { mcpStore } from '../../../contexts/mcp'
import { IntegrationLabels, type ConnectStep } from './integration-labels'
import { McpAddressForm } from './mcp-address-form.svelte'
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
   * Add a server the person describes: a command (docs/plans/mcp-first-class.md
   * §7.7) or an address. The first step is its form, in place of the sign-in.
   * `name` and `url` are empty.
   */
  addsServer?: boolean
}

/** What a new server is: a command the host starts, or an address it reaches. */
export type AddKind = 'command' | 'url'

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
  /** The form of a command; null when the dialog opened for a server it knows. */
  readonly command: McpCommandForm | null
  /** The form the person fills before the add: null once an address went on to its sign-in, and for a known server. */
  addKind = $state<AddKind | null>(null)
  /** The server at an address this run adds or connects: the request's, or the one the person typed. */
  target = $state({ name: '', url: '' })
  /** The URL form: the address, its name, and its Authentication. */
  readonly addressForm = new McpAddressForm()
  /** The Authentication the URL form chose, kept for Try again until the host has the record. */
  private pendingAuth: IntegrationAuthChoice | undefined
  /** The header values the URL form took, given to the host once the record exists. */
  private pendingValues: IntegrationEnvValue[] = []
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
    this.target = { name: request.name, url: request.url }
    this.command = request.addsServer ? new McpCommandForm(serverId, mayRunCommands) : null
    if (request.addsServer) this.addKind = 'command'
    if (this.integration) this.seedDraft(this.integration)
  }

  get integration(): Integration | null {
    const id = this.integrationId
    return id ? mcpStore.integrations.states.get(this.serverId)?.integrations?.find((item) => item.id === id) ?? null : null
  }

  get step(): ConnectStep {
    if (this.addKind === 'command' && !this.isCommandStarted) return 'command'
    if (this.addKind === 'url') return 'address'
    const integration = this.integration
    return integration ? new IntegrationLabels(integration).connectStep(mcpStore.integrations.connection(this.serverId, integration.id)) : 'adding'
  }

  /** The reason the last Add stopped, while no record exists. */
  get addError(): string {
    const state = this.catalog.installs.get(this.target.url)
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
      name: this.integration?.name ?? this.target.name,
      url: this.integration?.url ?? this.target.url,
      callbackUrl: need === 'oauth-client' ? mcpStore.integrations.oauthRedirectUrl(this.serverId) : undefined,
      guideUrl: this.request.authHelp,
    })
  }

  private get setupNeed(): IntegrationSetupNeed | null {
    const integration = this.integration
    if (!integration) {
      const state = this.catalog.installs.get(this.target.url)
      return state?.kind === 'failed' ? state.setupNeed ?? null : null
    }
    return new IntegrationSignIn(integration).setupNeedFor(mcpStore.integrations.connection(this.serverId, integration.id))
  }

  /**
   * Hand the setup to an agent: keep a server this run added, so the person
   * finds it waiting in Settings, and close. The caller opens the conversation.
   */
  keepForHandoff(): void {
    this.addedHere = false
  }

  get isAdding(): boolean {
    const state = this.catalog.installs.get(this.target.url)
    return !this.integrationId && !!state && state.kind !== 'failed'
  }

  /** A save, the values, or the start of the command runs. */
  get isStartingCommand(): boolean {
    const id = this.integrationId
    return !!this.command?.isSaving || this.isSendingValues || (!!id && !!this.processes?.isStarting(id))
  }

  private isSendingValues = $state(false)

  private get processes() {
    return mcpStore.integrations.states.get(this.serverId)?.processes
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
    const hasValues = mcpStore.integrations.connection(this.serverId, integration.id)?.status === 'connected'
    if (values) {
      this.isSendingValues = true
      const saved = await mcpStore.integrations.submitValues(this.serverId, integration.id, values)
      this.isSendingValues = false
      if (!saved) {
        const flow = mcpStore.integrations.connectFlow(this.serverId, integration.id)
        form.problem = { field: 'envNames', reason: flow?.kind === 'values' && flow.error ? flow.error : 'The host did not save the values.' }
        await mcpStore.integrations.cancel(this.serverId, integration.id)
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

  /** The person can change between a command and an address until the host has a record of either. */
  get canChangeKind(): boolean {
    return this.addKind !== null && !this.integrationId
  }

  chooseKind(kind: AddKind): void {
    if (this.canChangeKind) this.addKind = kind
  }

  /**
   * The address form's Continue: the dialog goes on as it does for a catalog
   * entry, to the check, the sign-in, and the tools. An address the host has
   * already goes to that server's sign-in, as the page's search does.
   */
  async continueWithAddress(): Promise<void> {
    if (this.addKind !== 'url') return
    const check = this.addressForm.check()
    if (!check) return
    const known = mcpStore.integrations.states.get(this.serverId)?.integrations?.find((integration) => integration.url === check.url) ?? null
    this.target = { name: known?.name ?? check.name, url: check.url }
    this.addKind = null
    this.addressForm.takeSecrets()
    if (known) {
      this.integrationId = known.id
      this.seedDraft(known)
      return
    }
    this.pendingAuth = check.auth
    this.pendingValues = check.values
    await this.start()
  }

  /** Back to the address form after the host refused the address, to change it. */
  editAddress(): void {
    if (this.integrationId || !this.request.addsServer) return
    this.catalog.dismiss(this.target.url)
    this.target = { name: '', url: '' }
    this.pendingAuth = undefined
    this.pendingValues = []
    this.addKind = 'url'
  }

  /** Adds the server when the dialog opened for a catalog entry, or the person gave its address. */
  async start(): Promise<void> {
    if (this.integrationId || this.addKind) return
    const integration = await this.catalog.install(this.target.name, this.target.url, this.pendingAuth)
    if (!integration) return
    this.addedHere = true
    this.integrationId = integration.id
    this.seedDraft(integration)
    this.pendingAuth = undefined
    const values = this.pendingValues
    this.pendingValues = []
    // A failed save leaves the values flow open with the reason, in the sign-in step.
    if (values.length > 0) await mcpStore.integrations.submitValues(this.serverId, integration.id, values)
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
    const saved = await mcpStore.integrations.update(this.serverId, { id: integration.id, disabledTools: [...this.disabledDraft] })
    this.isSaving = false
    if (!saved) {
      this.saveError = mcpStore.integrations.states.get(this.serverId)?.writeError || 'Could not save the tools. Try again.'
      mcpStore.integrations.clearWriteError(this.serverId)
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
      if (this.target.url) this.catalog.dismiss(this.target.url)
      return
    }
    // Remove stops the process too; a command kept stops only a start that runs.
    if (this.addKind === 'command' && !this.addedHere && this.processes?.isStarting(id)) await this.processes.stop(id)
    const flow = mcpStore.integrations.connectFlow(this.serverId, id)
    if (flow && flow.kind !== 'failed') await mcpStore.integrations.cancel(this.serverId, id)
    if (this.addedHere) await mcpStore.integrations.remove(this.serverId, id)
  }

  private seedDraft(integration: Integration): void {
    this.disabledDraft.clear()
    for (const name of integration.disabledTools) this.disabledDraft.add(name)
  }
}
