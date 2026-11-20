import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from '../helpers/bun-sqlite'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Integration } from '@solus/contracts/integration-types'
import type { AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'

mock.module('node:sqlite', () => ({ DatabaseSync }))

const { IntegrationGateway } = await import('@solus/server/integrations/gateway')
const { integrationToolbox, setIntegrationGateway } = await import('@solus/server/integrations/integration-tools')
const { HOST_ACTOR } = await import('@solus/server/admission/actor')
const { withActingScope } = await import('@solus/server/vault/acting-scope')
const { HOST_SCOPE } = await import('@solus/server/execution/seats/acting-identity')
const { expandUriTemplate } = await import('@solus/server/integrations/resource-lists')
const { attachResource } = await import('@solus/server/integrations/resource-attach')
const { agentResultOf } = await import('@solus/server/integrations/result-content')

/**
 * MCP resources (docs/plans/mcp-first-class.md §11.1 to §11.4) against real
 * streamable HTTP servers on a loopback port: one with resources, one with
 * tools only.
 */

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const upstream: McpServer[] = []
const servers: Server[] = []
let notes = 'first version'
let withResources: Integration
let toolsOnly: Integration

function resourceServer(): McpServer {
  const server = new McpServer({ name: 'docs', version: '1.0.0' })
  server.registerTool('noop', { description: 'Nothing.' }, async () => ({ content: [{ type: 'text', text: 'ok' }] }))
  server.registerResource('Release notes', 'docs://notes', { mimeType: 'text/markdown', title: 'Release notes' }, async () => ({ contents: [{ uri: 'docs://notes', mimeType: 'text/markdown', text: notes }] }))
  server.registerResource('Logo', 'docs://logo', { mimeType: 'image/png' }, async () => ({ contents: [{ uri: 'docs://logo', mimeType: 'image/png', blob: PNG_1X1 }] }))
  server.registerResource('Spec', 'docs://spec', { mimeType: 'application/pdf' }, async () => ({ contents: [{ uri: 'docs://spec', mimeType: 'application/pdf', blob: Buffer.from('%PDF-1.4 spec').toString('base64') }] }))
  server.registerResource('File', new ResourceTemplate('file:///{+path}', { list: undefined }), { mimeType: 'text/plain' }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: `contents of ${uri.href}` }] }))
  return server
}

function toolServer(): McpServer {
  const server = new McpServer({ name: 'tools', version: '1.0.0' })
  server.registerTool('noop', { description: 'Nothing.' }, async () => ({ content: [{ type: 'text', text: 'ok' }] }))
  return server
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
}

async function serve(make: () => McpServer): Promise<string> {
  const transports = new Map<string, StreamableHTTPServerTransport>()
  const httpServer = createServer(async (req, res) => {
    const parsed = req.method === 'POST' ? await body(req) : undefined
    const sessionId = req.headers['mcp-session-id']
    let transport = typeof sessionId === 'string' ? transports.get(sessionId) : undefined
    if (!transport) {
      const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => { transports.set(id, created) },
      })
      const server = make()
      upstream.push(server)
      await server.connect(created)
      transport = created
    }
    await transport.handleRequest(req, res, parsed)
  })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  servers.push(httpServer)
  return `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`
}

function record(id: string, slug: string, url: string): Integration {
  return {
    id, organizationId: 'local', ownerKey: 'local:test', kind: 'mcp', slug, name: slug === 'docs' ? 'Docs' : 'Tools', url,
    auth: { kind: 'none' }, disabledTools: [], createdAt: '2026-11-20T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z',
  }
}

function gatewayFor(...records: Integration[]) {
  return new IntegrationGateway({ get: (id) => records.find((entry) => entry.id === id) ?? null, list: () => records })
}

/** The host's own work: reads with no person, as a run of the host does. */
function asHost<T>(read: () => Promise<T>): Promise<T> {
  return withActingScope(HOST_SCOPE, read)
}

function context(): AgentToolContext {
  return { provider: 'claude-code', cwd: '/tmp', sessionId: () => 'session-1', abortSignal: new AbortController().signal, parentToolUseId: () => undefined, emit: () => {} }
}

beforeAll(async () => {
  withResources = record('int-docs', 'docs', await serve(resourceServer))
  toolsOnly = record('int-tools', 'tools', await serve(toolServer))
})

afterAll(async () => {
  setIntegrationGateway(null)
  await Promise.all(upstream.map((server) => server.close()))
  for (const server of servers) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

describe('MCP resources', () => {
  test('lists resources and templates once, and a list-changed notification drops the list', async () => {
    const gateway = gatewayFor(withResources)
    const changed = new Promise<string>((resolve) => gateway.onFactsChanged(resolve))
    const lists = await gateway.resourcesFor(withResources.id, null, null)
    expect(lists.resources.map((resource) => resource.uri)).toEqual(['docs://notes', 'docs://logo', 'docs://spec'])
    expect(lists.resources[0]).toMatchObject({ name: 'Release notes', title: 'Release notes', mimeType: 'text/markdown' })
    expect(lists.templates).toEqual([{ uriTemplate: 'file:///{+path}', name: 'File', mimeType: 'text/plain' }])
    // The person picks from the cached list: no new request for the same answer.
    expect(await gateway.resourcesFor(withResources.id, null, null)).toBe(lists)

    upstream.at(-1)!.sendResourceListChanged()
    expect(await changed).toBe(withResources.id)
    expect(await gateway.resourcesFor(withResources.id, null, null)).not.toBe(lists)
    await gateway.close()
  })

  test('the tools join a run only when one of its servers has resources', async () => {
    const onlyTools = gatewayFor(toolsOnly)
    setIntegrationGateway(onlyTools)
    const without = (await integrationToolbox(HOST_ACTOR)).tools.map((tool) => tool.name)
    expect(without).not.toContain('list_integration_resources')
    await onlyTools.close()

    const both = gatewayFor(withResources, toolsOnly)
    setIntegrationGateway(both)
    const tools = (await integrationToolbox(HOST_ACTOR)).tools
    const list = tools.find((tool) => tool.name === 'list_integration_resources')!
    const read = tools.find((tool) => tool.name === 'read_integration_resource')!
    expect(list.requiresApproval).toBe(false)
    expect(read.description).toContain('docs')
    expect(read.description).not.toContain('tools')

    const listed = JSON.parse((await asHost(() => list.execute({}, context()))).text)
    expect(listed.resources.map((entry: { uri?: string; uriTemplate?: string }) => entry.uri ?? entry.uriTemplate)).toEqual(['docs://notes', 'docs://logo', 'docs://spec', 'file:///{+path}'])
    expect(listed.note).toContain('uriTemplate')

    // A read maps text, an image, and a blob as §6 does.
    const text = await asHost(() => read.execute({ server: 'docs', uri: 'docs://notes' }, context()))
    expect(text.text).toContain('Resource docs://notes:\nfirst version')
    const image = await asHost(() => read.execute({ server: 'docs', uri: 'docs://logo' }, context()))
    expect(image.images?.[0]?.mimeType).toBe('image/png')
    const blob = await asHost(() => read.execute({ server: 'docs', uri: 'docs://spec' }, context()))
    expect(blob.text).toMatch(/Resource docs:\/\/spec \(application\/pdf, .*\) saved at .*\.pdf/)
    // A server that is not of this run is refused by name.
    expect((await asHost(() => read.execute({ server: 'tools', uri: 'docs://notes' }, context()))).text).toContain('Servers with resources: docs')
    await both.close()
  })

  test('an attach gives a file in the conversation store and a normal attachment', async () => {
    const gateway = gatewayFor(withResources)
    const attachmentsDir = mkdtempSync(join(tmpdir(), 'resource-attach-'))
    notes = 'the notes of this moment'
    const [file] = await asHost(() => attachResource({ gateway, integration: withResources, request: { integrationId: withResources.id, uri: 'docs://notes' }, starter: null, bucketId: 'session-1', attachmentsDir }))
    expect(file).toMatchObject({ type: 'file', name: 'Release notes.md', mimeType: 'text/markdown' })
    expect(file.hostPath!.startsWith(attachmentsDir)).toBe(true)
    expect(readFileSync(file.hostPath!, 'utf8')).toBe('the notes of this moment')

    const [image] = await asHost(() => attachResource({ gateway, integration: withResources, request: { integrationId: withResources.id, uri: 'docs://logo' }, starter: null, bucketId: 'session-1', attachmentsDir }))
    expect(image).toMatchObject({ type: 'image', name: 'Logo.png', mimeType: 'image/png' })

    const [expanded] = await asHost(() => attachResource({
      gateway, integration: withResources, starter: null, bucketId: 'session-1', attachmentsDir,
      request: { integrationId: withResources.id, uriTemplate: 'file:///{+path}', arguments: [{ name: 'path', value: 'src/a b.ts' }] },
    }))
    expect(readFileSync(expanded.hostPath!, 'utf8')).toBe('contents of file:///src/a%20b.ts')
    await gateway.close()
  })

  test('a template expands {name} and {+name} and refuses other operators', () => {
    const values = new Map([['path', 'src/app.ts'], ['q', 'a b']])
    expect(expandUriTemplate('file:///{+path}', values)).toBe('file:///src/app.ts')
    expect(expandUriTemplate('file:///{path}', values)).toBe('file:///src%2Fapp.ts')
    expect(() => expandUriTemplate('search://{?q}', values)).toThrow('Solus expands only {name} and {+name}')
    expect(() => expandUriTemplate('file:///{+missing}', values)).toThrow('Give a value for missing.')
  })

  test('a resource link names the read tool only for a server with resources', async () => {
    const link = { content: [{ type: 'resource_link' as const, uri: 'docs://notes', name: 'notes', mimeType: 'text/markdown' }] }
    expect((await agentResultOf(link, { tool: 'search', resourceServer: 'docs' })).text).toBe('Resource link: notes <docs://notes> (text/markdown) Read it with `read_integration_resource`, server `docs`.')
    expect((await agentResultOf(link, { tool: 'search' })).text).toBe('Resource link: notes <docs://notes> (text/markdown)')
  })
})
