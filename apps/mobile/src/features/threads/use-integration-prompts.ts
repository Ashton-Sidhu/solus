import { useCallback, useMemo } from 'react'
import type { HostEventName } from '@solus/contracts/host-events'
import type { IntegrationPrompt, IntegrationPromptList, IntegrationPromptText } from '@solus/contracts/integrations/prompts'
import { filledArguments, type ArgumentValue } from '@solus/client-core/integration-prompts'
import { useApp } from '../../app/app-context'
import { useHostRead, type HostReadState } from '../hosts/use-host-read'

/** The last list of each host and project: an opening shows it at once while it reads again. */
const kept = new Map<string, IntegrationPromptList>()

/** A sign-in or a sign-out changes which prompts the person sees. */
const REFRESH_ON: readonly HostEventName[] = ['integration.changed', 'integration.connectionChanged']

/**
 * The MCP prompts of one host and project for the composer's sheet
 * (docs/plans/mcp-first-class.md §10). Read when the sheet opens, again on
 * `integration.changed`, on a sign-in change, and on reconnect.
 */
export function useIntegrationPrompts(hostId: string, projectPath: string) {
  const app = useApp()
  const key = `${hostId}\u0000${projectPath}`
  const { state: read, reload } = useHostRead(hostId, key, async (api) => {
    const list = await api.integrationPromptList(projectPath ? { projectPath } : {})
    kept.set(key, list)
    return list
  }, REFRESH_ON)
  // A kept list stays: a failed refresh is not a reason to hide it.
  const list = read.kind === 'loaded' ? read.value : kept.get(key)
  const state = useMemo((): HostReadState<IntegrationPromptList> => (list ? { kind: 'loaded', value: list } : read), [list, read])

  /** Expands one prompt with the given values. The answer's text is the person's message. */
  const expand = useCallback(async (prompt: IntegrationPrompt, values: readonly ArgumentValue[], sessionId: string): Promise<IntegrationPromptText> => {
    const connection = app.connections.connection(hostId)
    if (!connection) throw new Error('The host is not connected.')
    return connection.api.integrationPromptGet({ integrationId: prompt.integrationId, name: prompt.name, arguments: filledArguments(values), sessionId })
  }, [app, hostId])

  return { state, reload, expand }
}
