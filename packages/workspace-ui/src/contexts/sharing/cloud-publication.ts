import { isSolusApiId, solusApiId } from '@solus/contracts/uplink'
import type { ShareResource } from '@solus/contracts/sharing'
import { serverConnections } from '@solus/client-core/server-connections'
import { rpcErrorCode } from '@solus/client-core/rpc-error'
import { savedWorkspaceFor } from '@solus/client-core/workspace-registry'
import type { WorksStore } from '../works/works.store.svelte'
import { serversStore } from '../connections/servers.store.svelte'
import { LOCAL_ORGANIZATION_ID } from '../../lib/organization-filter'

/** How putting a Local work or task into an organization ended. */
export type PublishOutcome =
  | { kind: 'committed'; cloudServerId: string }
  | { kind: 'failed'; error: string }
  /** The machine holding the resource is not connected; nothing can be sent. */
  | { kind: 'offline' }
  /** The organization refused: this account may not publish there. */
  | { kind: 'denied'; error: string }

/** Where a Local work's upload stands, as the dialog shows it. */
export type PublishStatus = { kind: 'pending' } | Exclude<PublishOutcome, { kind: 'committed' }>

export interface PublishRequest {
  /** The machine the resource lives on. */
  serverId: string
  resource: ShareResource
  organizationId: string
}

/**
 * A Local work or task leaves its machine as a cloud copy
 * (docs/plans/cloud-sharing.md §3): read from the machine, uploaded to the
 * Solus API with this client's sign-in under the same id, then marked moved on
 * the machine, which keeps its content. Every step is safe to repeat: the same
 * resource uploaded again answers as before, so an upload that stopped halfway
 * finishes the next time. A session stays on its host and is never uploaded.
 */
export class CloudPublication {
  works: WorksStore | null = null
  /** One upload per resource at a time: a second request joins the first. */
  private readonly uploads = new Map<string, { organizationId: string; result: Promise<PublishOutcome> }>()

  /** `onMoved` hears of every resource that left a machine, so a cache of its old home can drop it. */
  constructor(private readonly onMoved: (serverId: string, resource: ShareResource) => void = () => {}) {}

  /** The workspace service that holds the resource: the server it is on, or the organization a work moved to; null while it is Local. */
  cloudHomeOf(serverId: string, resource: ShareResource): string | null {
    if (isSolusApiId(serverId)) return serverId
    if (resource.kind !== 'work') return null
    const organizationId = this.works?.works[resource.id]?.organizationId
    return organizationId && organizationId !== LOCAL_ORGANIZATION_ID ? solusApiId(organizationId) : null
  }

  /** The organization's workspace service is reached through the account's directory; read it only when this client does not know the service yet. */
  async reachCloud(cloudServerId: string): Promise<void> {
    if (!savedWorkspaceFor(cloudServerId)) await serversStore.refreshDirectory()
  }

  /** Put one Local work or task into one organization; a second request for the same resource joins the first. */
  upload(request: PublishRequest): Promise<PublishOutcome> {
    const key = `${request.serverId}|${request.resource.kind}|${request.resource.id}`
    const running = this.uploads.get(key)
    if (running) {
      return running.organizationId === request.organizationId
        ? running.result
        : Promise.resolve({ kind: 'failed', error: 'This resource is already being published to another organization.' })
    }
    const result = this.runUpload(request).finally(() => { this.uploads.delete(key) })
    this.uploads.set(key, { organizationId: request.organizationId, result })
    return result
  }

  private async runUpload(request: PublishRequest): Promise<PublishOutcome> {
    const { serverId, resource, organizationId } = request
    if (resource.kind === 'session') return { kind: 'failed', error: 'A session stays on its host.' }
    if (serverConnections.readinessFor(serverId).readiness !== 'ready') return { kind: 'offline' }
    try {
      return resource.kind === 'work'
        ? await this.uploadWork(serverId, resource.id, organizationId)
        : await this.uploadTask(serverId, resource.id, organizationId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof Error && rpcErrorCode(error) === 'FORBIDDEN') return { kind: 'denied', error: message }
      return { kind: 'failed', error: message }
    }
  }

  private async uploadWork(serverId: string, workId: string, organizationId: string): Promise<PublishOutcome> {
    const host = serverConnections.apiFor(serverId)
    const transfer = await host.workExportForCloud(workId)
    const cloudServerId = solusApiId(organizationId)
    await this.reachCloud(cloudServerId)
    await serverConnections.apiFor(cloudServerId).workUpload(transfer)
    await host.workMarkMoved(workId, transfer.fingerprint, organizationId)
    this.works?.markPublished(workId, organizationId, cloudServerId)
    this.onMoved(serverId, { kind: 'work', id: workId })
    return { kind: 'committed', cloudServerId }
  }

  /**
   * A task goes with its linked Local works (docs/plans/cloud-sharing.md §4):
   * the works go first, so the cloud task never links to a work the cloud does
   * not have. Linked sessions stay where they are.
   */
  private async uploadTask(serverId: string, taskId: string, organizationId: string): Promise<PublishOutcome> {
    const host = serverConnections.apiFor(serverId)
    const { task, works } = await host.taskExportForCloud(taskId)
    const cloudServerId = solusApiId(organizationId)
    await this.reachCloud(cloudServerId)
    const cloud = serverConnections.apiFor(cloudServerId)
    for (const work of works) await cloud.workUpload(work)
    await cloud.taskUpload(task)
    await host.taskMarkMoved(taskId, task.fingerprint, works.map((work) => ({ workId: work.work.id, fingerprint: work.fingerprint })), organizationId)
    for (const work of works) {
      this.works?.markPublished(work.work.id, organizationId, cloudServerId)
      this.onMoved(serverId, { kind: 'work', id: work.work.id })
    }
    this.onMoved(serverId, { kind: 'task', id: taskId })
    return { kind: 'committed', cloudServerId }
  }
}
