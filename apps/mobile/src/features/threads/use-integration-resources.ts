import type { Integration, IntegrationResource, IntegrationResourceTemplate } from '@solus/contracts/integration-types'
import { useApp } from '../../app/app-context'
import type { SolusApp } from '../../app/solus-app'
import { phoneHostProjectLists, useHostProjectList, type PhoneHostProjectLists } from '../hosts/host-project-lists'

/** The MCP resource sheet's list: the person's servers, their resources, and their templates on one host. */
export interface IntegrationResourceChoices {
  integrations: Integration[]
  resources: IntegrationResource[]
  templates: IntegrationResourceTemplate[]
}

const resourceLists = new WeakMap<SolusApp, PhoneHostProjectLists<IntegrationResourceChoices>>()

/**
 * The caller's MCP resources on one host for a project (docs/plans/mcp-first-class.md
 * §11.3), with the desktop rule: read when a sheet first opens and kept, read
 * again on `integration.changed`, which a server's list-changed notification
 * sends, and on reconnect. A failed refresh keeps the list.
 */
export function useIntegrationResources(hostId: string, projectPath: string) {
  const resources = phoneHostProjectLists(resourceLists, useApp(), {
    read: async (api, path) => {
      const [integrations, lists] = await Promise.all([api.integrationList(), api.integrationResourceList(path ? { projectPath: path } : {})])
      return { integrations, resources: lists.resources, templates: lists.templates }
    },
    empty: { integrations: [], resources: [], templates: [] },
    rereadOn: ['integration.changed'],
  })
  return useHostProjectList(resources, hostId, projectPath)
}
