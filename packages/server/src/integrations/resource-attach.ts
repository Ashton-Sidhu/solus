import type { Integration, IntegrationResourceAttachRequest } from '@solus/contracts/integration-types'
import type { Attachment } from '@solus/contracts/types'
import { uuid } from '@solus/contracts/uuid'
import { MAX_ATTACHMENT_UPLOAD_BYTES } from '@solus/contracts/rpc'
import { storeAttachmentBytes } from '../data/assets/attachment-store'
import { rasterImageMimeOf } from '../data/assets/assets'
import { formatByteSize } from '../data/assets/tool-result-media'
import { currentPersonKey } from '../vault/acting-scope'
import type { CommandStarter } from './command-admission'
import type { IntegrationGateway } from './gateway'
import { expandUriTemplate } from './resource-lists'
import { ConnectionRequiredError } from './upstream-session'

/** Content items of one read that become attachments; a prompt holds at most 8 uploads (§11.3). */
export const MAX_ATTACHED_CONTENTS = 8

/** The `[A-Za-z0-9._-]` extensions a saved text or file keeps, so the agent's tools know its type. */
const EXTENSION_OF = new Map([
  ['text/plain', 'txt'], ['text/markdown', 'md'], ['text/csv', 'csv'], ['text/html', 'html'],
  ['application/json', 'json'], ['application/pdf', 'pdf'], ['image/png', 'png'], ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'], ['image/webp', 'webp'],
])

/**
 * Reads one MCP resource as the caller and keeps each content item in the
 * conversation's attachment store (docs/plans/mcp-first-class.md §11.3). The
 * contents are those of this moment. An image whose bytes are that image type
 * is an `image` attachment; anything else is a `file`. `Attachment` gains no
 * member: from here it is a normal attachment.
 */
export async function attachResource(deps: {
  gateway: Pick<IntegrationGateway, 'readResource' | 'resourcesFor' | 'askToConnect'>
  integration: Pick<Integration, 'id' | 'name' | 'auth'>
  request: IntegrationResourceAttachRequest
  starter: CommandStarter
  bucketId: string
  /** The conversation that shows the connect card; a draft has none. */
  sessionId?: string
  attachmentsDir?: string
}): Promise<Attachment[]> {
  const { gateway, integration, request } = deps
  const uri = 'uri' in request ? request.uri : expandUriTemplate(request.uriTemplate, new Map(request.arguments.map((argument) => [argument.name, argument.value])))
  let contents
  try {
    contents = (await gateway.readResource(integration.id, uri, deps.starter)).contents
  } catch (error) {
    if (!(error instanceof ConnectionRequiredError)) throw error
    if (deps.sessionId) gateway.askToConnect(integration, deps.sessionId)
    throw new Error(integration.auth.kind === 'env'
      ? `CONNECTION_REQUIRED: Give the environment values of ${integration.name} in Settings → MCP.`
      : integration.auth.kind === 'headers'
        ? `CONNECTION_REQUIRED: Give the header values of ${integration.name} in Settings → MCP.`
        : `CONNECTION_REQUIRED: Sign in to ${integration.name} in Settings → MCP.`)
  }
  if (!contents.length) throw new Error(`${integration.name} returned nothing for ${uri}.`)
  if (contents.length > MAX_ATTACHED_CONTENTS) throw new Error(`${integration.name} returned ${contents.length} parts for ${uri}; Solus attaches at most ${MAX_ATTACHED_CONTENTS}.`)
  const name = await listedName(deps, uri)
  const attachments: Attachment[] = []
  for (const [index, content] of contents.entries()) {
    const declared = (content.mimeType ?? '').toLowerCase().split(';', 1)[0].trim()
    const bytes = 'text' in content ? Buffer.from(content.text, 'utf8') : Buffer.from(content.blob, 'base64')
    if (bytes.length > MAX_ATTACHMENT_UPLOAD_BYTES) throw new Error(`${content.uri} is ${formatByteSize(bytes.length)}; an attachment may be at most ${formatByteSize(MAX_ATTACHMENT_UPLOAD_BYTES)}.`)
    // A type is checked against the bytes: the server's word alone does not make an image.
    const image = 'blob' in content && declared.startsWith('image/') ? rasterImageMimeOf(bytes) : null
    const mimeType = image ?? (declared || ('text' in content ? 'text/plain' : 'application/octet-stream'))
    const fileName = withExtension(contents.length > 1 ? `${name} ${index + 1}` : name, mimeType)
    const hostPath = await storeAttachmentBytes(deps.bucketId, fileName, mimeType, bytes, deps.attachmentsDir)
    attachments.push({ id: uuid(), type: image ? 'image' : 'file', name: fileName, path: hostPath, hostPath, mimeType, size: bytes.length })
  }
  return attachments
}

/** The name the server listed for the URI, else the last part of the URI. */
async function listedName(deps: Parameters<typeof attachResource>[0], uri: string): Promise<string> {
  const lists = await deps.gateway.resourcesFor(deps.integration.id, currentPersonKey(), deps.starter).catch(() => null)
  const listed = lists?.resources.find((resource) => resource.uri === uri)
  if (listed) return listed.title ?? listed.name
  const tail = uri.replace(/[?#].*$/, '').split('/').filter(Boolean).at(-1)
  return tail ? decodeURIComponentSafe(tail) : 'resource'
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function withExtension(name: string, mimeType: string): string {
  const extension = EXTENSION_OF.get(mimeType)
  return extension && !name.toLowerCase().endsWith(`.${extension}`) ? `${name}.${extension}` : name
}
