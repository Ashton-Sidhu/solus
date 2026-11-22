import { z } from 'zod'
import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport, SdkHttpError } from '@modelcontextprotocol/client'

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
 * One `server/discover` (or the SDK legacy fallback) and `tools/list` with a credential, then the
 * session is closed. Proves the server accepts the credential and reads the
 * identity it reports. The credential, an `Authorization` header or a
 * `headers` server's headers, goes to `url` only.
 */
export async function readServerIdentity(url: string, credential: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<ServerIdentity> {
  const client = new Client({ name: 'solus', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: credential },
    fetch: (input, init) => fetchImpl(input, { ...init, redirect: 'manual' }),
  })
  try {
    await client.connect(transport, { timeout: IDENTITY_TIMEOUT_MS })
    await client.listTools(undefined, { timeout: IDENTITY_TIMEOUT_MS })
    const discover = client.getDiscoverResult()
    const info = z.object({ name: z.string(), title: z.string().optional() }).safeParse(discover?._meta?.['io.modelcontextprotocol/serverInfo'])
    if (info.success) return { label: info.data.title ?? info.data.name }
    const legacy = client.getServerVersion()
    return { label: legacy?.title ?? legacy?.name ?? null }
  } catch (error) {
    if (error instanceof SdkHttpError && (error.status === 401 || error.status === 403)) {
      throw new ServerCredentialRefusedError('The server refused this credential.')
    }
    throw new ServerCredentialRefusedError(`The server could not be used with this credential: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`)
  } finally {
    await client.close().catch(() => undefined)
  }
}
