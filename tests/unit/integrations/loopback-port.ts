import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { SOLUS_CLIENT_METADATA, type ClientMetadataDocument } from '@solus/contracts/integrations/client-metadata-document'
import { INTEGRATION_OAUTH_LOOPBACK_PATH } from '@solus/contracts/integrations/oauth-callback'

/**
 * A loopback port free now, for a test host's callback listener. Tests never
 * bind the fixed port: test files run at once, and the developer's Solus may
 * hold it.
 */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      server.close(() => resolve(port))
    })
  })
}

/** Solus's metadata document as published, naming the callback of a test host on `port` too. */
export function documentNaming(port: number): ClientMetadataDocument {
  return { ...SOLUS_CLIENT_METADATA, redirect_uris: [...SOLUS_CLIENT_METADATA.redirect_uris, `http://127.0.0.1:${port}${INTEGRATION_OAUTH_LOOPBACK_PATH}`] }
}
