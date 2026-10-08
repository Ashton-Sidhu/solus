import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

/** What `initialize` told Solus about the server: its title, else its name. */
export interface ServerIdentity {
  label: string | null
}

/** The server refused the credential, or could not be used with it. The message is for the person. */
export class ServerCredentialRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ServerCredentialRefusedError'
  }
}

const IDENTITY_TIMEOUT_MS = 15_000

/**
 * One `initialize` and `tools/list` with a credential (§4.3 step 5), then the
 * session is closed. Proves the server accepts the credential and reads the
 * identity it reports. The credential goes to `url` only.
 */
export async function readServerIdentity(url: string, authorization: string, fetchImpl: typeof fetch = fetch): Promise<ServerIdentity> {
  const client = new Client({ name: 'solus', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization } },
    fetch: (input, init) => fetchImpl(input, { ...init, redirect: 'manual' }),
  })
  try {
    await client.connect(transport, { timeout: IDENTITY_TIMEOUT_MS })
    await client.listTools(undefined, { timeout: IDENTITY_TIMEOUT_MS })
    const info = client.getServerVersion()
    return { label: info?.title ?? info?.name ?? null }
  } catch (error) {
    if (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403)) {
      throw new ServerCredentialRefusedError('The server refused this credential.')
    }
    throw new ServerCredentialRefusedError(`The server could not be used with this credential: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`)
  } finally {
    await client.close().catch(() => undefined)
  }
}
