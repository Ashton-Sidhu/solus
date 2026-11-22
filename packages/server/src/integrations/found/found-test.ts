import { Client, SdkHttpError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { FoundTransport, IntegrationToolSummary } from '@solus/contracts/integration-types'
import { cancellableFetch } from '../cancellable-fetch'
import { toolSummary } from '../integration-tools'
import { stdioTransport } from '../stdio-process'
import type { EntrySecrets } from './config-entry'

/** A test that has no answer in this time has failed; the process is stopped. */
const TEST_TIMEOUT_MS = 30_000

/**
 * A test of a found server (docs/plans/mcp-first-class.md §8.8): start it as
 * its file says, with the values the file gives, read `tools/list`, and stop
 * it. Nothing is saved. A command runs with no shell, as the gateway runs one
 * (§7.3); a URL gets the file's Authorization header and nothing else.
 */
export async function testFoundServer(transport: FoundTransport, secrets: EntrySecrets, cwd: string): Promise<IntegrationToolSummary[]> {
  if (transport.kind === 'sse') throw new Error('It uses the HTTP+SSE transport, which MCP deprecated.')
  if (transport.kind === 'stdio') {
    const missing = transport.envNames.filter((name) => !secrets.env.has(name))
    if (missing.length) throw new Error(`The file gives no value for ${missing.join(', ')}. Add the server to give the values.`)
  }
  const client = new Client({ name: 'solus', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } })
  const connection = transport.kind === 'stdio'
    ? stdioTransport({ launch: { command: transport.command, args: transport.args, cwd: transport.cwd ?? cwd } }, [...secrets.env].map(([name, value]) => ({ name, value })))
    : new StreamableHTTPClientTransport(new URL(transport.url), {
      requestInit: { headers: secrets.authorization ? { Authorization: secrets.authorization } : {}, redirect: 'error' },
      fetch: cancellableFetch(),
    })
  try {
    await client.connect(connection, { timeout: TEST_TIMEOUT_MS })
    const { tools } = await client.listTools(undefined, { timeout: TEST_TIMEOUT_MS })
    return tools.map(toolSummary)
  } catch (error) {
    if (error instanceof SdkHttpError && (error.status === 401 || error.status === 403)) throw new Error('The server needs a sign-in. Add it, then connect.')
    throw new Error(`The server did not answer: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`)
  } finally {
    await client.close().catch(() => undefined)
  }
}
