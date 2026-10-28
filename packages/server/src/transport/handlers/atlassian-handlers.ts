import { z } from 'zod'
import type {
  AtlassianApiTokenConnectResult,
  AtlassianJiraProject,
  AtlassianOAuthStartResult,
  AtlassianStatus,
} from '@solus/contracts/atlassian'
import type { SolusServer } from '../server'
import { atlassianRequest, connectedSite } from '../../atlassian/api'
import { clearCredential, loadCredential } from '../../atlassian/token-store'
import {
  AtlassianCallbackPortBusyError,
  AtlassianOAuthUnconfiguredError,
  cancelOAuthFlow,
  isOAuthConfigured,
  startOAuthFlow,
} from '../../atlassian/oauth'
import { AtlassianApiTokenError } from '@solus/contracts/atlassian-api-token'
import { connectWithApiToken } from '../../atlassian/api-token'
import { isApiMode } from '../../host/api-mode'
import { usesAccountIntegration } from '../../vault/vault'

export interface AtlassianHandlerDependencies {
  cancelOAuthFlow: typeof cancelOAuthFlow
  connectWithApiToken: typeof connectWithApiToken
  isOAuthConfigured: typeof isOAuthConfigured
  startOAuthFlow: typeof startOAuthFlow
}

const defaultDependencies: AtlassianHandlerDependencies = {
  cancelOAuthFlow,
  connectWithApiToken,
  isOAuthConfigured,
  startOAuthFlow,
}

export function registerAtlassianHandlers(
  server: SolusServer,
  dependencies: AtlassianHandlerDependencies = defaultDependencies,
): void {
  server.register('atlassianStatus', async (): Promise<AtlassianStatus> => {
    const credential = await loadCredential()
    // The account website owns the connection there; a host keeps a pasted token.
    const apiTokenAvailable = !usesAccountIntegration()
    if (!credential) return { connected: false, oauthAvailable: dependencies.isOAuthConfigured(), apiTokenAvailable }
    const status: AtlassianStatus = {
      connected: true,
      siteUrl: credential.siteUrl,
      cloudId: credential.cloudId,
      products: credential.products,
      oauthAvailable: dependencies.isOAuthConfigured(),
      apiTokenAvailable,
      authMethod: credential.kind ?? 'oauth',
    }
    if (credential.siteName) status.siteName = credential.siteName
    return status
  })

  server.register('atlassianStartOAuth', async (args): Promise<AtlassianOAuthStartResult> => {
    try {
      // The workspace service has no loopback for a browser to reach: the sign-in
      // lands on its own callback route at the origin the client reached it by
      // (cloud-service-model.md §22). A host keeps the fixed-port listener.
      const [callbackBaseUrl] = args
      if (isApiMode()) {
        if (!callbackBaseUrl) return { ok: false, error: 'The workspace service needs the callback origin to start an Atlassian sign-in.' }
        return { ok: true, ...(await dependencies.startOAuthFlow({ callbackBaseUrl })) }
      }
      return { ok: true, ...(await dependencies.startOAuthFlow()) }
    } catch (error) {
      // Both arms are the user's to act on — a build with no client, or a port
      // another program holds — so they answer rather than raise.
      if (error instanceof AtlassianOAuthUnconfiguredError || error instanceof AtlassianCallbackPortBusyError) {
        return { ok: false, error: error.message }
      }
      throw error
    }
  })

  server.register('atlassianCancelOAuth', () => {
    dependencies.cancelOAuthFlow()
  })

  // A pasted token replaces whatever grant was there, so a browser sign-in
  // still waiting must not land on top of it.
  server.register('atlassianConnectApiToken', async (args): Promise<AtlassianApiTokenConnectResult> => {
    const [input] = args
    try {
      dependencies.cancelOAuthFlow()
      await dependencies.connectWithApiToken(input)
      return { ok: true }
    } catch (error) {
      if (error instanceof AtlassianApiTokenError) return { ok: false, error: error.message }
      throw error
    }
  })

  // Local only: this drops Solus's copy of the grant. Revoking it at Atlassian
  // is the user's to do from their account, and is deliberately not implied.
  server.register('atlassianDisconnect', async () => {
    dependencies.cancelOAuthFlow()
    await clearCredential()
  })

  // The choice a project's Jira binding is made from. Nothing else needs the
  // list, so it is read live rather than cached — a project created in Jira a
  // minute ago must be pickable.
  server.register('atlassianJiraProjects', async (): Promise<AtlassianJiraProject[]> => {
    const site = await connectedSite('jira')
    // An empty list must only ever mean "this site has no Jira projects".
    // Answering `[]` for an unusable connection is how a dead grant came to
    // read as an empty project list.
    if (!site) {
      throw new Error('The Atlassian connection is not usable. Sign in again in Settings → Integrations.')
    }
    const page = await atlassianRequest(
      {
        product: 'jira',
        cloudId: site.cloudId,
        path: '/rest/api/3/project/search',
        query: { maxResults: '200', orderBy: 'name' },
      },
      jiraProjectPageSchema,
    )
    return page.values
  })
}

const jiraProjectPageSchema = z.object({
  values: z.array(z.object({ key: z.string(), name: z.string() })),
})
