import { useCallback, useEffect, useRef, useState } from 'react'
import type { IntegrationPrompt, IntegrationPromptList, IntegrationPromptText } from '@solus/contracts/integrations/prompts'
import { filledArguments, type ArgumentValue } from '@solus/client-core/integration-prompts'
import { useApp, useListened } from '../../app/app-context'

export type IntegrationPromptsState =
  | { kind: 'loading' }
  | { kind: 'loaded'; list: IntegrationPromptList }
  | { kind: 'error'; message: string }

/** The last list of each host and project: an opening shows it at once while it reads again. */
const kept = new Map<string, IntegrationPromptList>()

/**
 * The MCP prompts of one host and project for the composer's sheet
 * (docs/plans/mcp-first-class.md §10). Read when the sheet opens, again on
 * `integration.changed`, on a sign-in change, and on reconnect, only while
 * it is open. A reply from an older read or a gone connection is dropped.
 */
export function useIntegrationPrompts(hostId: string, projectPath: string, open: boolean) {
  const app = useApp()
  const readiness = useListened(app.connections.changes, () => app.connections.state(hostId)?.readiness)
  const key = `${hostId}\u0000${projectPath}`
  const [state, setState] = useState<IntegrationPromptsState>(() => {
    const list = kept.get(key)
    return list ? { kind: 'loaded', list } : { kind: 'loading' }
  })
  const request = useRef(0)

  const reload = useCallback(() => {
    const connection = app.connections.connection(hostId)
    if (!connection) return
    const at = ++request.current
    const list = kept.get(key)
    setState(list ? { kind: 'loaded', list } : { kind: 'loading' })
    connection.api.integrationPromptList(projectPath ? { projectPath } : {}).then(
      (answer) => {
        if (at !== request.current || app.connections.connection(hostId) !== connection) return
        kept.set(key, answer)
        setState({ kind: 'loaded', list: answer })
      },
      (cause: unknown) => {
        if (at !== request.current || app.connections.connection(hostId) !== connection) return
        // A kept list stays: a failed refresh is not a reason to hide it.
        if (!kept.has(key)) setState({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) })
      },
    )
  }, [app, hostId, key, projectPath])

  useEffect(() => {
    if (!open || readiness !== 'ready') return
    reload()
    const connection = app.connections.connection(hostId)
    if (!connection) return
    const stopChanged = connection.events.subscribe('integration.changed', reload)
    const stopConnection = connection.events.subscribe('integration.connectionChanged', reload)
    return () => {
      stopChanged()
      stopConnection()
    }
  }, [app, hostId, open, readiness, reload])

  /** Expands one prompt with the given values. The answer's text is the person's message. */
  const expand = useCallback(async (prompt: IntegrationPrompt, values: readonly ArgumentValue[], sessionId: string): Promise<IntegrationPromptText> => {
    const connection = app.connections.connection(hostId)
    if (!connection) throw new Error('The host is not connected.')
    return connection.api.integrationPromptGet({ integrationId: prompt.integrationId, name: prompt.name, arguments: filledArguments(values), sessionId })
  }, [app, hostId])

  return { state, reload, expand }
}
