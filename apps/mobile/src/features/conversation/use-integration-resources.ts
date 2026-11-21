import type { Integration, IntegrationResource, IntegrationResourceTemplate } from '@solus/contracts/integration-types'
import type { HostEventName } from '@solus/contracts/host-events'
import { useHostRead, type HostReadState } from '../hosts/use-host-read'

/** The MCP resource sheet's list: the person's servers, their resources, and their templates on one host. */
export type IntegrationResourcesState = HostReadState<{ integrations: Integration[]; resources: IntegrationResource[]; templates: IntegrationResourceTemplate[] }>

const REFRESH_ON: readonly HostEventName[] = ['integration.changed']

/**
 * The caller's MCP resources on one host for a project (docs/plans/mcp-first-class.md
 * §11.3), read when the sheet opens and again on `integration.changed`, which
 * a server's list-changed notification sends.
 */
export function useIntegrationResources(hostId: string, projectPath: string): IntegrationResourcesState {
  return useHostRead(hostId, projectPath, async (api) => {
    const [integrations, lists] = await Promise.all([api.integrationList(), api.integrationResourceList({ projectPath })])
    return { integrations, resources: lists.resources, templates: lists.templates }
  }, REFRESH_ON).state
}
