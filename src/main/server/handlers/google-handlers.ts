import { createLogger } from '../../logger'
import { getAccessToken, disconnect, startGoogleOAuthFlow } from '../../google/oauth'
import { uploadMarkdownAsDoc } from '../../google/drive'
import type { SolusServer } from '../server'

const log = createLogger('main', 'google-handlers')

export interface GoogleHandlersDeps {
  getServerInfo(): { host: string; port: number }
}

interface GoogleUploadDocArgs {
  title: string
  markdown: string
  oauthCallbackBaseUrl?: string
}

export function registerGoogleHandlers(server: SolusServer, deps: GoogleHandlersDeps): void {
  server.register('googleUploadDoc', async (args) => {
    const [{ title, markdown, oauthCallbackBaseUrl }] = args as [GoogleUploadDocArgs]
    try {
      const accessToken = await getAccessToken()
      if (!accessToken) {
        const { host, port } = deps.getServerInfo()
        return startGoogleOAuthFlow({
          callbackBaseUrl: oauthCallbackBaseUrl,
          fallbackHost: host,
          fallbackPort: port,
        })
      }
      const { docUrl } = await uploadMarkdownAsDoc(accessToken, title, markdown)
      return { docUrl }
    } catch (err) {
      console.log(err)
      const message = err instanceof Error ? err.message : String(err)
      log.error(`googleUploadDoc failed: ${message}`)
      return { error: message }
    }
  })

  server.register('googleDisconnect', async () => {
    disconnect()
  })
}
