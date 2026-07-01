import { createLogger } from '../../logger'
import { getAccessToken, disconnect } from '../../google/oauth'
import { uploadMarkdownAsDoc } from '../../google/drive'
import type { SolusServer } from '../server'

const log = createLogger('main', 'google-handlers')

export function registerGoogleHandlers(server: SolusServer): void {
  server.register('googleUploadDoc', async (args) => {
    const [{ title, markdown }] = args as [{ title: string; markdown: string }]
    try {
      const accessToken = await getAccessToken()
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
