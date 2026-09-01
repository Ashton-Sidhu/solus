import type { GoogleAuthStatus } from '@solus/contracts/google-auth'
import {
  disconnect,
  getAccessToken,
  grantedGoogleScopes,
  isGoogleOAuthConfigured,
  startGoogleOAuthFlow,
} from '../../google/oauth'
import type { SolusServer } from '../server'

export interface GoogleHandlersDeps {
  getServerInfo(): { host: string; port: number }
}

export function registerGoogleHandlers(server: SolusServer, deps: GoogleHandlersDeps): void {
  server.register('googleStatus', async () => {
    const configured = isGoogleOAuthConfigured()
    const connected = configured && !!(await getAccessToken())
    // Granted scopes, not requested ones: a grant approved before
    // `drive.readonly` shipped is still connected but cannot read a doc Solus
    // did not create, and the client turns that into a reconnect prompt.
    const status: GoogleAuthStatus = { connected, configured }
    const scopes = connected ? grantedGoogleScopes() : null
    if (scopes) status.scopes = scopes
    return status
  })

  server.register('googleConnect', async (args) => {
    const { host, port } = deps.getServerInfo()
    return startGoogleOAuthFlow({ callbackBaseUrl: args[0], fallbackHost: host, fallbackPort: port })
  })

  server.register('googleDisconnect', async () => {
    disconnect()
  })
}
