import { SvelteMap } from 'svelte/reactivity'
import type { HostApi } from '@solus/client-core/host-api'
import { serverConnections } from '@solus/client-core/server-connections'
import { resourceAttachRequest, type AttachedIntegrationResource, type Integration, type IntegrationResource, type IntegrationResourceLists, type IntegrationResourceTemplate } from '@solus/contracts/integration-types'
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
 * The caller's MCP resources on each host, for the `@` menu
 * (docs/plans/mcp-first-class.md §11.3, §11.4). A list is read when the menu
 * first opens for a host and project, never for a keystroke: the menu matches
 * on what is here. `integration.changed` drops a host's lists and reads the
 * ones in use again, so a list-changed notification on the server reaches the
 * menu. A host that cannot list, or fails, has no section.
 */
class IntegrationResourcesStore {
  /** Keyed by host and project folder. */
  private readonly lists = new SvelteMap<string, IntegrationResourceLists>()
  private readonly loading = new Map<string, number>()
  private readonly followed = new Map<string, () => void>()
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

  /** What the menu matches on; empty while the first list loads. */
  resourcesFor(serverId: string, projectPath: string | undefined): IntegrationResource[] {
    return this.lists.get(listKey(serverId, projectPath))?.resources ?? []
  }

  /** The templates the menu offers beside the resources; the argument form fills one before the attach. */
  templatesFor(serverId: string, projectPath: string | undefined): IntegrationResourceTemplate[] {
    return this.lists.get(listKey(serverId, projectPath))?.templates ?? []
  }

  /** Reads the list for this host and project once; the menu calls it when `@` opens. */
  ensure(serverId: string, projectPath: string | undefined): void {
    const key = listKey(serverId, projectPath)
    this.installing ??= import('./integrations.store.svelte').then((module) => { this.installed = module.integrationsStore })
    if (this.lists.has(key) || this.loading.has(key)) return
    this.follow(serverId)
    void this.load(serverId, projectPath)
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

  private follow(serverId: string): void {
    if (this.followed.has(serverId)) return
    const stop = serverConnections.eventsFor(serverId).subscribe('integration.changed', () => this.reload(serverId))
    this.followed.set(serverId, stop)
  }

  /** Every list of the host is read again; the old one stays until the new one lands. */
  private reload(serverId: string): void {
    for (const key of this.lists.keys()) {
      const [host, projectPath] = key.split('\u0000')
      if (host === serverId) void this.load(serverId, projectPath || undefined)
    }
  }

  private async load(serverId: string, projectPath: string | undefined): Promise<void> {
    const key = listKey(serverId, projectPath)
    const attempt = (this.loading.get(key) ?? 0) + 1
    this.loading.set(key, attempt)
    try {
      const lists = await serverConnections.apiFor(serverId).integrationResourceList(projectPath ? { projectPath } : {})
      if (this.loading.get(key) === attempt) this.lists.set(key, lists)
    } catch {
      // An older host has no `integrationResourceList`, and a failed list shows no section (§11.4).
      if (this.loading.get(key) === attempt) this.lists.set(key, { resources: [], templates: [] })
    } finally {
      if (this.loading.get(key) === attempt) this.loading.delete(key)
    }
  }
}

function listKey(serverId: string, projectPath: string | undefined): string {
  return `${serverId}\u0000${projectPath ?? ''}`
}

export const integrationResources = new IntegrationResourcesStore()
