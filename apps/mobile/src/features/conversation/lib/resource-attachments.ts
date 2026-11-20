import type { Integration, IntegrationResource } from '@solus/contracts/integration-types'
import type { Attachment } from '@solus/contracts/types'
import type { UploadedAttachment } from './attachments'

/**
 * MCP resources in the composer's + menu (docs/plans/mcp-first-class.md §11.3).
 * The host reads a resource and answers normal attachments; from here they are
 * the composer's attachments like any upload.
 */

/** One server of the sheet and the resources that match the search. */
export interface ResourceSection {
  integrationId: string
  title: string
  data: IntegrationResource[]
}

/** The resources by server, in the order of the server names, with those that match `query` in name, title, or URI. */
export function resourceSections(integrations: readonly Pick<Integration, 'id' | 'name'>[], resources: readonly IntegrationResource[], query: string): ResourceSection[] {
  const needle = query.trim().toLowerCase()
  const matches = (resource: IntegrationResource) => !needle
    || [resource.name, resource.title ?? '', resource.uri].some((text) => text.toLowerCase().includes(needle))
  return [...integrations]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((integration) => ({
      integrationId: integration.id,
      title: integration.name,
      data: resources.filter((resource) => resource.integrationId === integration.id && matches(resource)),
    }))
    .filter((section) => section.data.length > 0)
}

/** The host's attachments as the composer holds them. An image is read by the host from its path, so it carries no bytes. */
export function resourceAttachments(read: readonly Attachment[]): UploadedAttachment[] {
  return read.flatMap((attachment) => attachment.hostPath
    ? [{
        id: attachment.id,
        kind: attachment.type === 'image' ? 'image' as const : 'file' as const,
        name: attachment.name,
        hostPath: attachment.hostPath,
        mimeType: attachment.mimeType ?? 'application/octet-stream',
        size: attachment.size ?? 0,
        dataUrl: null,
      }]
    : [])
}
