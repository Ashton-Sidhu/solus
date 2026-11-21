import { SvelteMap } from 'svelte/reactivity'
import type { HostApi } from '@solus/client-core/host-api'
import { resourceAttachRequest, type AttachedIntegrationResource, type Integration } from '@solus/contracts/integration-types'
import type { Attachment, IpcContext } from '@solus/contracts/types'
import { uuid } from '@solus/contracts/uuid'
import { attachmentUploads } from '../input/lib/attachment-uploads.svelte'
import type { integrationsStore } from './integrations.store.svelte'
import { serverIconUrl } from './lib/integration-labels'

/** The server an attached resource came from, for its chip's icon. */
interface ResourceChipServer {
  integrationId: string
  serverId: string
}

/**
 * The MCP resources a person attaches from the `@` menu, and their chips
 * (docs/plans/mcp-first-class.md §11.3). The lists the menu matches on are in
 * `integration-resource-lists.svelte.ts`, which loads with the menu, not with
 * the first screen.
 */
class IntegrationResourcesStore {
  /** Chips of attached resources, by attachment id. */
  private readonly chips = new SvelteMap<string, ResourceChipServer>()
  /**
   * The installed integrations, which name a resource's server. Read on the
   * first `@`, not with the first screen: the app loads that store after paint
   * (`app-core.ts`, startup-import-graph).
   */
  private installed = $state<typeof integrationsStore | null>(null)
  private installing: Promise<void> | null = null

  /** The host's installed integrations, once the first `@` loaded them. */
  integrationsOf(serverId: string): Integration[] {
    return this.installed?.states.get(serverId)?.integrations ?? []
  }

  /** Loads the installed integrations once; the menu calls it when `@` opens. */
  loadInstalled(): void {
    this.installing ??= import('./integrations.store.svelte').then((module) => { this.installed = module.integrationsStore })
  }

  /** The logo of the server an attached resource came from, for its chip; undefined for any other attachment. */
  chipIcon(attachmentId: string): { serverName: string; src: string } | undefined {
    const chip = this.chips.get(attachmentId)
    if (!chip) return undefined
    const integration = this.integrationsOf(chip.serverId).find((candidate) => candidate.id === chip.integrationId)
    return integration && { serverName: integration.name, src: serverIconUrl(integration.url) }
  }

  /**
   * Adds a chip for the resource at once and asks the host to read it (§11.3).
   * The chip shows the read; a failed read keeps the chip with Retry, and a
   * prompt sent meanwhile waits for it. The host's attachments take the chip's
   * place: one for each content item.
   */
  attach(request: { api: Pick<HostApi, 'integrationResourceAttach'>; ctx: IpcContext; serverId: string; resource: AttachedIntegrationResource; attachments: Attachment[] }): void {
    const { resource, attachments } = request
    const name = resource.title ?? resource.name
    const chip: Attachment = { id: uuid(), type: 'file', name, path: name, hostServerId: request.serverId, mimeType: resource.mimeType }
    attachments.push(chip)
    const server = { integrationId: resource.integrationId, serverId: request.serverId }
    this.chips.set(chip.id, server)
    const read = resourceAttachRequest(resource)
    attachmentUploads.read(
      chip,
      async () => (await request.api.integrationResourceAttach(request.ctx, read))
        .map((attachment) => ({ ...attachment, hostServerId: request.serverId })),
      (read) => {
        const index = attachments.findIndex((attachment) => attachment.id === chip.id)
        if (index < 0) return
        // The first keeps the chip's id, so a prompt that waited on the chip gets it.
        const placed = read.map((attachment, position) => (position === 0 ? { ...attachment, id: chip.id } : attachment))
        for (const attachment of placed) this.chips.set(attachment.id, server)
        attachments.splice(index, 1, ...placed)
      },
    )
  }
}

export const integrationResources = new IntegrationResourcesStore()
