import { z } from 'zod'
import published from './solus-client-metadata.json'

/**
 * The Solus Client ID Metadata Document (docs/plans/mcp-integrations.md §13.1;
 * draft-ietf-oauth-client-id-metadata-document, MCP 2026-07-28 client
 * registration). Solus's `client_id` is the HTTPS URL of this document, and an
 * authorization server that advertises `client_id_metadata_document_supported`
 * reads Solus's name and redirect addresses from it instead of a registration.
 *
 * `solus-client-metadata.json` is the one source: `apps/site` serves it at its
 * own `client_id`, and the host reads that published copy back before it signs
 * in with it (`integrations/client-metadata.ts` on the server). The URL is the
 * identity of Solus as an OAuth client; changing it is a new client at every
 * authorization server.
 *
 * Its redirect addresses are the host's loopback callbacks on the default
 * ports (desktop 3001, standalone 3000). A fixed document cannot name the
 * origin of a host it does not know, so a host reached any other way registers
 * dynamically, as before.
 */

/** What the host checks in a fetched document before it uses it: the fields an authorization server relies on. */
export const clientMetadataDocumentSchema = z.object({
  client_id: z.string().min(1),
  client_name: z.string().min(1),
  redirect_uris: z.array(z.string().min(1)).min(1),
  grant_types: z.array(z.string()).refine((grants) => grants.includes('authorization_code')).optional(),
  response_types: z.array(z.string()).refine((types) => types.includes('code')).optional(),
  // A public client: a shared secret is forbidden in the document (draft §4.1).
  token_endpoint_auth_method: z.literal('none').optional(),
})
export type ClientMetadataDocument = z.infer<typeof clientMetadataDocumentSchema>

/** The document as this build knows it; the published copy is the one an authorization server reads. */
export const SOLUS_CLIENT_METADATA: ClientMetadataDocument = clientMetadataDocumentSchema.parse(published)

/** Solus's OAuth client ID and the address of its metadata document. */
export const SOLUS_CLIENT_ID_URL = SOLUS_CLIENT_METADATA.client_id

/**
 * The rules for a client identifier URL (draft §3): HTTPS, a path other than
 * `/`, no user information, no fragment, and no dot segments. A query is
 * discouraged, so it is refused here too. The URL must already be in its
 * normal form, because an authorization server compares it as a plain string.
 */
export function isClientIdUrl(value: string): boolean {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  // A dot segment, a default port, or an upper-case host changes the parsed form.
  return url.href === value
    && url.protocol === 'https:'
    && !url.username && !url.password
    && url.pathname !== '/'
    && !value.includes('?') && !value.includes('#')
}

/**
 * Whether a document read from `url` is one Solus can sign in with: `url` is a
 * valid client identifier URL, and the document's `client_id` is equal to it
 * by simple string comparison (draft §4).
 */
export function namesItsUrl(document: ClientMetadataDocument, url: string): boolean {
  return isClientIdUrl(url) && document.client_id === url
}
