import { useCallback } from 'react'
import type { IntegrationPrompt, IntegrationPromptList, IntegrationPromptText } from '@solus/contracts/integrations/prompts'
import { filledArguments, type ArgumentValue } from '@solus/client-core/integration-prompts'
import { useApp } from '../../app/app-context'
import type { SolusApp } from '../../app/solus-app'
import { phoneHostProjectLists, useHostProjectList, type PhoneHostProjectLists } from '../hosts/host-project-lists'

const promptLists = new WeakMap<SolusApp, PhoneHostProjectLists<IntegrationPromptList>>()

/**
 * The MCP prompts of one host and project for the composer's sheet
 * (docs/plans/mcp-first-class.md §10), with the desktop rule: read when a
 * sheet first opens and kept, read again on `integration.changed`, on a
 * sign-in change (`integration.connectionChanged`), and on reconnect. A failed
 * refresh keeps the list.
 */
export function useIntegrationPrompts(hostId: string, projectPath: string) {
  const app = useApp()
  const prompts = phoneHostProjectLists(promptLists, app, {
    read: (api, path) => api.integrationPromptList(path ? { projectPath: path } : {}),
    empty: { prompts: [], signIn: [] },
    rereadOn: ['integration.changed', 'integration.connectionChanged'],
  })
  const list = useHostProjectList(prompts, hostId, projectPath)
  /** After a failed first read: read again. */
  const reload = useCallback(() => prompts.lists.ensure(hostId, projectPath), [prompts, hostId, projectPath])

  /** Expands one prompt with the given values. The answer's text is the person's message. */
  const expand = useCallback(async (prompt: IntegrationPrompt, values: readonly ArgumentValue[], sessionId: string): Promise<IntegrationPromptText> => {
    const connection = app.connections.connection(hostId)
    if (!connection) throw new Error('The host is not connected.')
    return connection.api.integrationPromptGet({ integrationId: prompt.integrationId, name: prompt.name, arguments: filledArguments(values), sessionId })
  }, [app, hostId])

  return { list, reload, expand }
}
