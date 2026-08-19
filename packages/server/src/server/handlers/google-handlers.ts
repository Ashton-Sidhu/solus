import { createLogger } from '../../logger'
import { getAccessToken, disconnect, startGoogleOAuthFlow } from '../../google/oauth'
import { z } from 'zod'
import { uploadHtmlAsDoc, uploadMarkdownAsDoc } from '../../google/drive'
import { buildGoogleDocHtml } from '../../google/document-html'
import type { SolusServer } from '../server'

const log = createLogger('main', 'google-handlers')

const diagramAssetSchema = z.object({
  workId: z.string().min(1),
  title: z.string().min(1).max(300),
  mimeType: z.literal('image/png'),
  base64: z.string().min(1).max(4_000_000),
})

const googleUploadSchema = z.object({
  title: z.string().min(1).max(300),
  markdown: z.string(),
  diagramAssets: z.array(diagramAssetSchema).max(20).optional(),
  oauthCallbackBaseUrl: z.string().optional(),
})

export interface GoogleHandlersDeps {
  getServerInfo(): { host: string; port: number }
}

export function registerGoogleHandlers(server: SolusServer, deps: GoogleHandlersDeps): void {
  server.register('googleUploadDoc', async (args) => {
    try {
      const { title, markdown, diagramAssets = [], oauthCallbackBaseUrl } = googleUploadSchema.parse(args[0])
      const decodedBytes = diagramAssets.reduce((total, asset) => total + Buffer.from(asset.base64, 'base64').byteLength, 0)
      if (decodedBytes > 12 * 1024 * 1024) throw new Error('The embedded diagrams are too large to upload together.')
      for (const asset of diagramAssets) {
        const bytes = Buffer.from(asset.base64, 'base64')
        if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
          throw new Error(`Diagram “${asset.title}” is not a valid PNG image.`)
        }
      }
      const accessToken = await getAccessToken()
      if (!accessToken) {
        const { host, port } = deps.getServerInfo()
        return startGoogleOAuthFlow({
          callbackBaseUrl: oauthCallbackBaseUrl,
          fallbackHost: host,
          fallbackPort: port,
        })
      }
      const result = diagramAssets.length
        ? await uploadHtmlAsDoc(accessToken, title, await buildGoogleDocHtml(markdown, diagramAssets))
        : await uploadMarkdownAsDoc(accessToken, title, markdown)
      const { docUrl } = result
      return { docUrl }
    } catch (err) {
      console.log(err)
      const message = err instanceof Error ? err.message : String(err)
      log.error('google_upload_doc_failed', { error: message })
      return { error: message }
    }
  })

  server.register('googleDisconnect', async () => {
    disconnect()
  })
}
