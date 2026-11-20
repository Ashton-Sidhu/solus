import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { DatabaseSync } from '../helpers/bun-sqlite'
import type { Integration, IntegrationConnectNeeded } from '@solus/contracts/integration-types'
import { MAX_MCP_PROMPT_TEXT_CHARS } from '@solus/contracts/integrations/prompts'
import type { Actor } from '@solus/server/admission/actor'
import type { SavedServerRow, ServerFactsStore } from '@solus/server/integrations/server-facts-store'

mock.module('node:sqlite', () => ({ DatabaseSync }))

const { IntegrationGateway } = await import('@solus/server/integrations/gateway')
const { integrationPromptList, integrationPromptText } = await import('@solus/server/integrations/integration-prompts')
const { withActingScope } = await import('@solus/server/vault/acting-scope')
const { HOST_IDENTITY, HOST_SCOPE } = await import('@solus/server/execution/seats/acting-identity')
const { HOST_ACTOR } = await import('@solus/server/admission/actor')
const { resolveProjectKey } = await import('@solus/server/project-config/project-config')

/**
 * MCP prompts as slash commands (docs/plans/mcp-first-class.md §10), against a
 * real streamable HTTP MCP server on a loopback port: the list with its
 * command names, the expansion into the person's message, and the states a
 * client shows (no connection, a missing argument, a list that changed).
 */

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const upstream: McpServer[] = []
/** The arguments each `prompts/get` reached the server with. */
const received: Array<Record<string, string | undefined>> = []
const headers: Array<string | undefined> = []
let httpServer: Server
let base: Integration
let workDir: string

function makeServer(): McpServer {
  const server = new McpServer({ name: 'prompts-fake', version: '1.0.0' })
  server.registerTool('noop', { description: 'Nothing.' }, async () => ({ content: [{ type: 'text', text: 'ok' }] }))
  server.registerPrompt('review pr', {
    title: 'Review a pull request',
    description: 'Review one pull request.',
    argsSchema: { number: z.string().describe('The pull request number'), focus: z.string().optional() },
  }, (args) => {
    received.push(args)
    return {
      messages: [
        { role: 'user', content: { type: 'text', text: `Review pull request ${args.number}.` } },
        { role: 'assistant', content: { type: 'text', text: 'I will read the diff first.' } },
        { role: 'user', content: { type: 'image', data: PNG_1X1, mimeType: 'image/png' } },
        { role: 'user', content: { type: 'resource', resource: { uri: 'file:///notes.md', mimeType: 'text/markdown', text: 'Check the tests.' } } },
      ],
    }
  })
  server.registerPrompt('standup', { description: 'Write the standup.' }, () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'Write my standup.' } }] }))
  server.registerPrompt('huge', { description: 'Too long.' }, () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'x'.repeat(MAX_MCP_PROMPT_TEXT_CHARS + 10) } }] }))
  return server
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
}

function gatewayFor(...records: Integration[]) {
  return new IntegrationGateway({ get: (id) => records.find((record) => record.id === id) ?? null, list: () => records })
}

const MEMBER_ACTOR: Actor = {
  principal: { kind: 'org-member', userId: 'member-1', organizationId: 'org-1', organizationRole: 'member', teamIds: [], hostKind: 'managed', displayName: 'Member', deviceId: 'member-device', deviceLabel: 'Browser', expiresAt: Date.now() + 300_000 },
  user: { id: { kind: 'account', accountId: 'member-1' }, displayName: 'Member' },
}
const MEMBER_SCOPE = { identity: HOST_IDENTITY, personKey: 'member-1' }

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'solus-prompts-'))
  const transports = new Map<string, StreamableHTTPServerTransport>()
  httpServer = createServer(async (req, res) => {
    headers.push(req.headers.authorization)
    const parsed = req.method === 'POST' ? await body(req) : undefined
    const sessionId = req.headers['mcp-session-id']
    let transport = typeof sessionId === 'string' ? transports.get(sessionId) : undefined
    if (!transport) {
      const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => { transports.set(id, created) },
      })
      const server = makeServer()
      upstream.push(server)
      await server.connect(created)
      transport = created
    }
    await transport.handleRequest(req, res, parsed)
  })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const { port } = httpServer.address() as AddressInfo
  base = {
    id: 'int-prompts',
    organizationId: 'local',
    ownerKey: 'local:test',
    kind: 'mcp',
    slug: 'github',
    name: 'GitHub',
    url: `http://127.0.0.1:${port}/mcp`,
    auth: { kind: 'none' },
    disabledTools: [],
    createdAt: '2026-11-20T00:00:00Z',
    updatedAt: '2026-11-20T00:00:00Z',
  }
})

afterAll(async () => {
  await Promise.all(upstream.map((server) => server.close()))
  httpServer.closeAllConnections()
  await new Promise<void>((resolve) => httpServer.close(() => resolve()))
  rmSync(workDir, { recursive: true, force: true })
})

describe('MCP prompts', () => {
  test('a prompt lists with its command, and a character outside the command set becomes _', async () => {
    const gateway = gatewayFor(base)
    try {
      const list = await withActingScope(HOST_SCOPE, () => integrationPromptList(gateway, HOST_ACTOR))
      expect(list.signIn).toEqual([])
      expect(list.prompts.map((prompt) => prompt.command)).toEqual(['/github:review_pr', '/github:standup', '/github:huge'])
      const review = list.prompts[0]
      // WHY: the client sends the server's own name, not the command, so a renamed character still reaches the right prompt.
      expect(review).toMatchObject({ integrationId: base.id, integrationName: 'GitHub', name: 'review pr', title: 'Review a pull request' })
      expect(review.arguments).toEqual([
        { name: 'number', description: 'The pull request number', required: true },
        { name: 'focus', required: false },
      ])
    } finally {
      await gateway.close()
    }
  })

  test('two servers with one command: the first wins, and the other is left out', async () => {
    const twin: Integration = { ...base, id: 'int-twin', name: 'GitHub copy' }
    const gateway = gatewayFor(base, twin)
    try {
      const list = await withActingScope(HOST_SCOPE, () => integrationPromptList(gateway, HOST_ACTOR))
      expect(list.prompts.filter((prompt) => prompt.command === '/github:standup').map((prompt) => prompt.integrationId)).toEqual([base.id])
    } finally {
      await gateway.close()
    }
  })

  test('the expanded text is the person\'s message: arguments reach prompts/get, an assistant part is marked, an image is an attachment', async () => {
    const gateway = gatewayFor(base)
    const attachmentsDir = mkdtempSync(join(workDir, 'attachments-'))
    try {
      received.length = 0
      const answer = await withActingScope(HOST_SCOPE, () => integrationPromptText(gateway, HOST_ACTOR, base, {
        integrationId: base.id, name: 'review pr', arguments: [{ name: 'number', value: '42' }], sessionId: 'session-1',
      }, { attachmentsDir }))
      expect(received).toEqual([{ number: '42' }])
      if (answer.kind !== 'text') throw new Error('expected text')
      expect(answer.text).toBe('Review pull request 42.\n\nAssistant:\nI will read the diff first.\n\nResource file:///notes.md:\nCheck the tests.')
      // WHY: a run reads an image only from the attachment store (`resolvePromptImages`), so the image must be there, never a data URL in the RPC.
      expect(answer.attachments).toHaveLength(1)
      const [image] = answer.attachments
      expect(image).toMatchObject({ type: 'image', mimeType: 'image/png' })
      expect(image.hostPath?.startsWith(attachmentsDir)).toBe(true)
      expect(readFileSync(image.hostPath!).toString('base64')).toBe(PNG_1X1)
      expect(JSON.stringify(answer)).not.toContain(PNG_1X1)
    } finally {
      await gateway.close()
    }
  })

  test('a required argument that is missing is refused before the server is asked', async () => {
    const gateway = gatewayFor(base)
    try {
      received.length = 0
      const missing = withActingScope(HOST_SCOPE, () => integrationPromptText(gateway, HOST_ACTOR, base, {
        integrationId: base.id, name: 'review pr', arguments: [{ name: 'number', value: '  ' }], sessionId: 'session-1',
      }))
      await expect(missing).rejects.toThrow('/github:review_pr needs number.')
      expect(received).toEqual([])
    } finally {
      await gateway.close()
    }
  })

  test('text past the limit is cut, and the line names the limit', async () => {
    const gateway = gatewayFor(base)
    try {
      const answer = await withActingScope(HOST_SCOPE, () => integrationPromptText(gateway, HOST_ACTOR, base, { integrationId: base.id, name: 'huge', arguments: [] }))
      if (answer.kind !== 'text') throw new Error('expected text')
      expect(answer.text.startsWith('x'.repeat(MAX_MCP_PROMPT_TEXT_CHARS))).toBe(true)
      expect(answer.text).toContain(`[Left out: the last 10 characters of the prompt. A prompt sends at most ${MAX_MCP_PROMPT_TEXT_CHARS.toLocaleString('en-US')} characters.]`)
    } finally {
      await gateway.close()
    }
  })

  test('a server the person is not connected to is a sign-in, not an error, in the list and on send', async () => {
    const secure: Integration = { ...base, id: 'int-secure', slug: 'secure', name: 'Secure', ownerKey: 'member-1', auth: { kind: 'bearer', scheme: 'bearer' } }
    const gateway = gatewayFor(secure)
    gateway.useCredentials({ authorizationFor: async () => null, markNeedsSignIn: () => {} })
    const raised: IntegrationConnectNeeded[] = []
    gateway.onConnectNeeded((request) => raised.push(request))
    try {
      headers.length = 0
      const list = await withActingScope(MEMBER_SCOPE, () => integrationPromptList(gateway, MEMBER_ACTOR))
      expect(list).toEqual({ prompts: [], signIn: [{ integrationId: secure.id, integrationName: 'Secure', slug: 'secure', needs: 'sign-in' }] })
      const answer = await withActingScope(MEMBER_SCOPE, () => integrationPromptText(gateway, MEMBER_ACTOR, secure, {
        integrationId: secure.id, name: 'standup', arguments: [], sessionId: 'session-9',
      }))
      expect(answer).toEqual({ kind: 'connection-required', integrationId: secure.id, integrationName: 'Secure', needs: 'sign-in' })
      // WHY: the conversation shows the connect card, as for a tool call (§4.1 rule 2).
      expect(raised).toEqual([{ integrationId: secure.id, integrationName: 'Secure', sessionId: 'session-9' }])
      // A prompt is the person's: no anonymous request went to the server.
      expect(headers).toEqual([])
    } finally {
      await gateway.close()
    }
  })

  test('prompts/list_changed makes the next list new and tells clients to list again', async () => {
    const gateway = gatewayFor(base)
    try {
      await withActingScope(HOST_SCOPE, () => gateway.promptsFor(base.id, null))
      const server = upstream.at(-1)!
      const changed = new Promise<string>((resolve) => gateway.onFactsChanged(resolve))
      server.registerPrompt('added', { description: 'New.' }, () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'new' } }] }))
      expect(await changed).toBe(base.id)
      const names = (await withActingScope(HOST_SCOPE, () => gateway.promptsFor(base.id, null))).map((prompt) => prompt.name)
      expect(names).toContain('added')
    } finally {
      await gateway.close()
    }
  })

  test('a removed integration lists no prompts, and a project integration lists only in its project', async () => {
    const projectA = mkdtempSync(join(workDir, 'a-'))
    const projectB = mkdtempSync(join(workDir, 'b-'))
    const scoped: Integration = { ...base, projectKey: withActingScope(HOST_SCOPE, () => resolveProjectKey(projectA)) }
    const records = [scoped]
    const gateway = new IntegrationGateway({ get: (id) => records.find((record) => record.id === id) ?? null, list: () => records })
    try {
      const inA = await withActingScope(HOST_SCOPE, () => integrationPromptList(gateway, HOST_ACTOR, projectA))
      expect(inA.prompts.length).toBeGreaterThan(0)
      expect((await withActingScope(HOST_SCOPE, () => integrationPromptList(gateway, HOST_ACTOR, projectB))).prompts).toEqual([])
      records.length = 0
      expect((await withActingScope(HOST_SCOPE, () => integrationPromptList(gateway, HOST_ACTOR, projectA))).prompts).toEqual([])
    } finally {
      await gateway.close()
    }
  })

  test('a command that is not running answers from its saved facts and starts nothing', async () => {
    const command: Integration = { ...base, id: 'int-command', kind: 'stdio', slug: 'local', name: 'Local', launch: { command: 'definitely-not-installed-solus-test', args: [] } }
    const saved: SavedServerRow = {
      verdict: null,
      facts: {
        tools: [], era: 'modern', instructions: null,
        capabilities: { prompts: true, resources: false, resourceSubscribe: false, tasks: false },
        prompts: [{ name: 'plan', description: 'Plan the work.' }],
      },
    }
    const savedFacts = { get: () => saved } as unknown as ServerFactsStore
    const gateway = new IntegrationGateway({ get: (id) => (id === command.id ? command : null), list: () => [command] }, undefined, { savedFacts })
    try {
      const prompts = await withActingScope(MEMBER_SCOPE, () => gateway.promptsFor(command.id, 'member-1'))
      expect(prompts).toEqual([{ name: 'plan', description: 'Plan the work.' }])
      expect((await withActingScope(MEMBER_SCOPE, () => gateway.facts(command.id))).process?.state).toBe('stopped')
    } finally {
      await gateway.close()
    }
  })
})
