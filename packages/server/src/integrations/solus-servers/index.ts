import { solusServerAddress, solusServerIdOf, type CatalogEntry, type IntegrationAuth, type IntegrationProbeResult } from '@solus/contracts/integration-types'
import { gmailServer } from './gmail'
import { googleCalendarServer } from './google-calendar'
import { googleContactsServer } from './google-contacts'
import { googleDocsServer } from './google-docs'
import { googleDriveServer } from './google-drive'
import { googleFormsServer } from './google-forms'
import { googleMeetServer } from './google-meet'
import { googleSearchConsoleServer } from './google-search-console'
import { googleSheetsServer } from './google-sheets'
import { googleSlidesServer } from './google-slides'
import { googleTasksServer } from './google-tasks'
import type { SolusServerDefinition } from './solus-server'
import { hasFirstPartyClient } from '../first-party'

/**
 * The Solus MCP servers this build has (docs/plans/mcp-integrations.md §13.6).
 * A server is named by the address `solus:<id>` in its integration record.
 */
export const SOLUS_SERVERS: readonly SolusServerDefinition[] = [
  gmailServer,
  googleCalendarServer,
  googleDriveServer,
  googleDocsServer,
  googleSheetsServer,
  googleSlidesServer,
  googleFormsServer,
  googleTasksServer,
  googleContactsServer,
  googleMeetServer,
  googleSearchConsoleServer,
]

/** The servers this build has, as the catalog lists them: Solus entries, before the published Solus catalog. */
export function solusServerCatalogEntries(): CatalogEntry[] {
  return SOLUS_SERVERS.map((server) => ({
    id: `solus:${server.id}`,
    kind: 'solus',
    slug: server.id,
    name: server.name,
    description: server.description,
    domain: server.domain,
    icon: server.icon,
    categories: server.categories,
    popularity: null,
    url: solusServerAddress(server.id),
    source: 'solus',
  }))
}

/** The server an integration's address names, or null for a remote server or one this build lacks. */
export function solusServerFor(address: string): SolusServerDefinition | null {
  const id = solusServerIdOf(address)
  return id ? SOLUS_SERVERS.find((server) => server.id === id) ?? null : null
}

/**
 * Every Solus server signs in with OAuth at its vendor. None of the vendors
 * registers clients on request, so the person's own client is needed until
 * Solus's client for that vendor exists (§13.1).
 */
export function solusServerAuth(server: SolusServerDefinition): IntegrationAuth {
  const auth: IntegrationAuth = { kind: 'oauth', discover: server.auth.discover, registration: 'client-required' }
  if (server.auth.firstParty && hasFirstPartyClient(server.auth.firstParty)) auth.firstParty = server.auth.firstParty
  return auth
}

/**
 * What the probe answers for a `solus:` address: the server's own auth,
 * decided by its code, with no request. An address this build does not have
 * is refused as not an MCP server.
 */
export function probeSolusServer(address: string): IntegrationProbeResult {
  const server = solusServerFor(address)
  if (!server) return { outcome: 'undetermined', reason: 'not_mcp', signals: [] }
  return { outcome: 'oauth', auth: solusServerAuth(server), signals: [] }
}
