import { useCallback, useEffect, useRef, useState } from 'react'
import type { Integration, IntegrationResource, IntegrationResourceTemplate } from '@solus/contracts/integration-types'
import { useApp, useListened } from '../../app/app-context'
import { errorMessage } from '../settings/integrations'

/** The MCP resource sheet's list: the person's servers, their resources, and their templates on one host. */
export type IntegrationResourcesState =
  | { kind: 'loading' }
  | { kind: 'loaded'; integrations: Integration[]; resources: IntegrationResource[]; templates: IntegrationResourceTemplate[] }
  | { kind: 'error'; message: string }

/**
 * The caller's MCP resources on one host for a project (docs/plans/mcp-first-class.md
 * §11.3), read when the sheet opens and again on `integration.changed`, which
 * a server's list-changed notification sends. A reply from an older request,
 * or from a connection that has gone, is dropped.
 */
export function useIntegrationResources(hostId: string, projectPath: string): IntegrationResourcesState {
  const app = useApp()
  const readiness = useListened(app.connections.changes, () => app.connections.state(hostId)?.readiness)
  const [state, setState] = useState<IntegrationResourcesState>({ kind: 'loading' })
  const request = useRef(0)

  const load = useCallback(() => {
    const current = app.connections.connection(hostId)
    if (!current) return
    const at = ++request.current
    Promise.all([current.api.integrationList(), current.api.integrationResourceList({ projectPath })]).then(
      ([integrations, lists]) => {
        if (at !== request.current || app.connections.connection(hostId) !== current) return
        setState({ kind: 'loaded', integrations, resources: lists.resources, templates: lists.templates })
      },
      (cause: unknown) => {
        if (at !== request.current || app.connections.connection(hostId) !== current) return
        setState({ kind: 'error', message: errorMessage(cause) })
      },
    )
  }, [app, hostId, projectPath])

  useEffect(() => {
    if (readiness !== 'ready') return
    load()
    return app.connections.connection(hostId)?.events.subscribe('integration.changed', load)
  }, [app, hostId, load, readiness])

  return state
}
