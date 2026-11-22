import type { Integration, IntegrationResource, IntegrationResourceTemplate } from '@solus/contracts/integration-types'
import { templateArgumentFields } from '@solus/client-core/integration-prompts'
import type { Attachment } from '@solus/contracts/types'
import type { UploadedAttachment } from './attachments'

/**
 * MCP resources in the composer's + menu (docs/plans/mcp-first-class.md §11.3).
 * The host reads a resource and answers normal attachments; from here they are
 * the composer's attachments like any upload.
 */

/** A row of the sheet: a resource, or a template whose values the sheet asks for before the attach. */
export type ResourceChoice = IntegrationResource | IntegrationResourceTemplate

/** One server of the sheet and the resources and templates that match the search. */
export interface ResourceSection {
  integrationId: string
  title: string
  data: ResourceChoice[]
}

/** What a row reads as: its URI, or its template. */
export function resourceAddress(choice: ResourceChoice): string {
  return 'uri' in choice ? choice.uri : choice.uriTemplate
}

/**
 * The resources by server, in the order of the server names, then each
 * server's templates that the host can expand, with those that match `query`
 * in name, title, or address.
 */
export function resourceSections(integrations: readonly Pick<Integration, 'id' | 'name'>[], resources: readonly IntegrationResource[], query: string, templates: readonly IntegrationResourceTemplate[] = []): ResourceSection[] {
  const needle = query.trim().toLowerCase()
  const matches = (choice: ResourceChoice) => !needle
    || [choice.name, choice.title ?? '', resourceAddress(choice)].some((text) => text.toLowerCase().includes(needle))
  const choices: ResourceChoice[] = [...resources, ...templates.filter((template) => templateArgumentFields(template.uriTemplate) !== null)]
  return [...integrations]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((integration) => ({
      integrationId: integration.id,
      title: integration.name,
      data: choices.filter((choice) => choice.integrationId === integration.id && matches(choice)),
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
