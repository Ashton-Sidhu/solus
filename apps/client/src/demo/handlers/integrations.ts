import { arg } from './args'
import {
  catalogEntryInCategory,
  type CatalogPage,
  type IntegrationCatalogListRequest,
  type IntegrationIdRequest,
  type IntegrationUpdateRequest,
} from '@solus/contracts/integration-types'
import {
  DEMO_CATALOG,
  DEMO_INTEGRATION_CONNECTIONS,
  DEMO_INTEGRATION_TOOLS,
  DEMO_INTEGRATIONS,
} from '../fixtures/integrations'
import type { DemoServer } from '../fixtures/types'

/**
 * The MCP page, served from a fixed set of connected servers and a catalog.
 *
 * Reads answer from `fixtures/integrations.ts`. A tool switch or a rename lives
 * for the page load. Connecting a new server needs a real sign-in at the
 * vendor, which the demo cannot do, so it says so rather than pretending.
 */
export function registerIntegrationsHandlers(backend: DemoServer): void {
  const integrations = structuredClone(DEMO_INTEGRATIONS)
  const connections = structuredClone(DEMO_INTEGRATION_CONNECTIONS)
  const signInNeeded = (): never => {
    throw new Error('Connecting a server signs you in at its vendor. Run Solus on your own machine to connect one.')
  }

  backend.register('integrationList', () => integrations)
  backend.register('integrationConnectionList', () => connections)
  backend.register('integrationGet', (args) => {
    const { id } = arg<IntegrationIdRequest>(args, 0)
    return integrations.find((integration) => integration.id === id) ?? null
  })
  backend.register('integrationTools', (args) => DEMO_INTEGRATION_TOOLS.get(arg<IntegrationIdRequest>(args, 0).id) ?? [])
  backend.register('integrationUpdate', (args) => {
    const request = arg<IntegrationUpdateRequest>(args, 0)
    const integration = integrations.find((candidate) => candidate.id === request.id)
    if (!integration) throw new Error('That server is not installed.')
    if (request.name) integration.name = request.name
    if (request.disabledTools) integration.disabledTools = request.disabledTools
    return integration
  })
  backend.register('integrationRemove', (args) => {
    const { id } = arg<IntegrationIdRequest>(args, 0)
    const index = integrations.findIndex((integration) => integration.id === id)
    if (index === -1) return { removed: false }
    integrations.splice(index, 1)
    return { removed: true }
  })
  backend.register('integrationCatalogList', (args): CatalogPage => {
    const request = arg<IntegrationCatalogListRequest>(args, 0)
    const query = request.query?.trim().toLowerCase() ?? ''
    const matching = DEMO_CATALOG.filter((entry) =>
      (!request.category || catalogEntryInCategory(entry, request.category))
      && (!query || [entry.name, entry.description, entry.domain].some((field) => field.toLowerCase().includes(query))))
    const offset = request.offset ?? 0
    return { entries: matching.slice(offset, offset + (request.limit ?? matching.length)), total: matching.length }
  })
  backend.register('integrationProbe', signInNeeded)
  backend.register('integrationCreate', signInNeeded)
  backend.register('integrationConnectStart', signInNeeded)
}
