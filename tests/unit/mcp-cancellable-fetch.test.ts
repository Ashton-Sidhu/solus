import { afterEach, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { cancellableFetch } from '@solus/server/integrations/cancellable-fetch'

let server: Server | null = null
let client: Client | null = null

afterEach(async () => {
  await client?.close()
  client = null
  server?.closeAllConnections()
  server?.close()
  server = null
})

function signal(): { promise: Promise<void>; fire: () => void } {
  let fire!: () => void
  const promise = new Promise<void>((resolve) => { fire = resolve })
  return { promise, fire }
}

/** An MCP server that answers the handshake and never answers a tool call. */
async function slowServer() {
  const callArrived = signal()
  const cancelArrived = signal()
  server = createServer(async (req, res) => {
    // No standalone event stream and no session to end.
    if (req.method !== 'POST') return void res.writeHead(405).end()
    let body = ''
    for await (const chunk of req) body += chunk
    const message = JSON.parse(body)
    if (message.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'slow', version: '1' } } }))
    } else if (message.method === 'tools/call') {
      callArrived.fire()
    } else {
      if (message.method === 'notifications/cancelled') cancelArrived.fire()
      res.writeHead(202).end()
    }
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: new URL(`http://127.0.0.1:${port}/mcp`), callArrived, cancelArrived }
}

/** Stops a held tool call and answers whether the fetch of its POST was aborted. */
async function callFetchAborted(wrap: (base: FetchLike) => FetchLike): Promise<boolean> {
  const slow = await slowServer()
  let callSignal: AbortSignal | null | undefined
  const recording: FetchLike = (url, init) => {
    if (String(init?.body).includes('"tools/call"')) callSignal = init?.signal
    return fetch(url, init)
  }
  client = new Client({ name: 'test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(slow.url, { fetch: wrap(recording) }))
  const stop = new AbortController()
  const call = client.callTool({ name: 'slow', arguments: {} }, undefined, { signal: stop.signal })
  // Stop once the server holds the call, as a user's Stop would.
  await slow.callArrived.promise
  stop.abort(new Error('stopped'))
  await expect(call).rejects.toThrow()
  await slow.cancelArrived.promise
  return callSignal?.aborted ?? false
}

test('a stopped MCP tool call aborts the fetch of its open request', async () => {
  // WHY: a Stop must not leave a connection to the MCP server open until the server answers.
  expect(await callFetchAborted(cancellableFetch)).toBe(true)
})

test('the SDK alone leaves that fetch open after the cancel', async () => {
  // WHY: proves the leak this fetch closes is real in the installed SDK.
  expect(await callFetchAborted((base) => base)).toBe(false)
})
