import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { DatabaseSync } from './helpers/bun-sqlite'
import budget from './agent-context-budget.json'
import type { AgentTool, AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'
import { advertisedInputSchema } from '@solus/server/execution/agents/tools/agent-tool'
import { compactToolSchema } from '@solus/server/execution/agents/tools/compact-tool-schema'
import { adaptClaudeTools } from '@solus/server/execution/agents/claude/claude-tool-adapter'
import { adaptCodexTools } from '@solus/server/execution/agents/codex/codex-tool-adapter'

mock.module('node:sqlite', () => ({ DatabaseSync }))

let toolbox: AgentTool[] = []

beforeAll(async () => {
  const { solusToolbox } = await import('@solus/server/execution/agents/tools/solus-toolbox')
  toolbox = Object.values(solusToolbox).flatMap((group): AgentTool[] => Object.values(group))
})

const context: AgentToolContext = {
  provider: 'claude-code', cwd: '/tmp', sessionId: () => 'session-1', abortSignal: new AbortController().signal,
  parentToolUseId: () => undefined, emit: () => {},
}

/** The tool list as the model reads it: name, description, and input schema. */
function toolListBytes(tools: Array<{ name: string; description?: string; inputSchema: unknown }>): number {
  return Buffer.byteLength(JSON.stringify(tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))))
}

/** What the Claude SDK's in-process MCP server lists, through a real MCP client. */
async function claudeListing(tools: AgentTool[]) {
  const { server } = adaptClaudeTools(tools, context, 'default')
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  await server.instance.connect(serverSide)
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(clientSide)
  return { client, tools: (await client.listTools()).tools }
}

function codexListing(tools: AgentTool[]) {
  return adaptCodexTools(tools)[0]?.tools ?? []
}

/** The schema the model read before compaction. */
function fullSchema(agentTool: AgentTool) {
  return z.toJSONSchema(z.object(agentTool.inputFields), { io: 'input' })
}

// WHY: every Solus tool schema is sent to the model on every turn. A keyword
// that allows every value costs context and tells the model nothing, but a
// description, enum, required list, or real bound is how the model learns to
// call the tool right. Compaction may drop only the first kind.
describe('compactToolSchema', () => {
  test('drops what constrains nothing', () => {
    expect(compactToolSchema({
      count: z.number().int().default(3),
      tags: z.record(z.string(), z.unknown()).optional(),
      extra: z.looseObject({ on: z.boolean() }).optional(),
    })).toEqual({
      type: 'object',
      properties: {
        count: { type: 'integer' },
        tags: { type: 'object' },
        extra: { type: 'object', properties: { on: { type: 'boolean' } }, required: ['on'] },
      },
    })
  })

  test('keeps descriptions, enums, required lists, and real bounds', () => {
    expect(compactToolSchema({
      mode: z.enum(['a', 'b']).describe('Which mode.'),
      size: z.number().int().min(1).max(600),
      every: z.number().int().positive().optional(),
      name: z.string().min(1).max(80).regex(/^[a-z]+$/).optional(),
      keys: z.record(z.enum(['x']), z.boolean()).optional(),
      strict: z.strictObject({ on: z.boolean().optional() }).optional(),
    })).toEqual({
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['a', 'b'], description: 'Which mode.' },
        size: { type: 'integer', minimum: 1, maximum: 600 },
        every: { type: 'integer', exclusiveMinimum: 0 },
        name: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[a-z]+$' },
        keys: { type: 'object', propertyNames: { type: 'string', enum: ['x'] }, additionalProperties: { type: 'boolean' }, required: ['x'] },
        strict: { type: 'object', properties: { on: { type: 'boolean' } }, additionalProperties: false },
      },
      required: ['mode', 'size'],
    })
  })

  test('drops the null branch of an optional field only', () => {
    expect(compactToolSchema({
      optionalOne: z.string().nullable().optional().describe('Omit or null.'),
      optionalMany: z.union([z.string(), z.number()]).nullable().optional(),
      requiredNullable: z.number().nullable(),
    })).toEqual({
      type: 'object',
      properties: {
        optionalOne: { type: 'string', description: 'Omit or null.' },
        optionalMany: { type: ['string', 'number'] },
        requiredNullable: { type: ['number', 'null'] },
      },
      required: ['requiredNullable'],
    })
  })

  test('a field named like a noise keyword stays', () => {
    const schema = compactToolSchema({ default: z.string(), $schema: z.string() })
    expect(Object.keys(schema.properties ?? {})).toEqual(['default', '$schema'])
  })
})

describe('the schemas the model reads for every Solus tool', () => {
  test('each keeps its fields, required list, enums, and descriptions', () => {
    expect(toolbox.length).toBeGreaterThan(50)
    for (const agentTool of toolbox) {
      if (agentTool.passthroughInput) continue
      const full = fullSchema(agentTool)
      const advertised = advertisedInputSchema(agentTool)
      expect(Object.keys(advertised.properties ?? {}), agentTool.name).toEqual(Object.keys(full.properties ?? {}))
      expect(advertised.required, agentTool.name).toEqual(full.required)
      for (const keyword of ['"description":', '"enum":', '"minLength":', '"pattern":']) {
        expect(JSON.stringify(advertised).split(keyword).length, `${agentTool.name} ${keyword}`).toBe(JSON.stringify(full).split(keyword).length)
      }
    }
  })

  test('Claude and Codex get the same compact schema, and the list is smaller than the full one', async () => {
    const { client, tools: claudeTools } = await claudeListing(toolbox)
    const codexTools = codexListing(toolbox)
    expect(claudeTools.map((tool) => tool.name)).toEqual(codexTools.map((tool) => tool.name))
    for (const [index, tool] of claudeTools.entries()) {
      expect(JSON.parse(JSON.stringify(tool.inputSchema)), tool.name).toEqual(codexTools[index]!.inputSchema)
    }
    const full = toolListBytes(toolbox.map((agentTool) => ({ ...agentTool, inputSchema: fullSchema(agentTool) })))
    expect(toolListBytes(codexTools)).toBeLessThan(full)
    await client.close()
  })

  // WHY: the advertised schema leaves out a null branch and a default, but a
  // call is checked against the full fields, so a call that worked before the
  // change still works — on Claude, whose SDK checks the call first, too.
  test('a call the full schema accepts still runs on Claude', async () => {
    const inputs: object[] = []
    const tool: AgentTool = {
      name: 'nullable_tool',
      description: 'For the test.',
      inputFields: {
        model_id: z.string().nullable().optional().describe('Omit or null for the default.'),
        every: z.number().int().positive().optional(),
        report: z.boolean().default(true),
      },
      requiresApproval: false,
      execute: async (input) => { inputs.push(input); return { ok: true, text: 'ok' } },
    }
    const { client, tools } = await claudeListing([tool])
    expect(tools[0]!.inputSchema).toEqual({
      type: 'object',
      properties: {
        model_id: { type: 'string', description: 'Omit or null for the default.' },
        every: { type: 'integer', exclusiveMinimum: 0 },
        report: { type: 'boolean' },
      },
    })
    expect((await client.callTool({ name: tool.name, arguments: { model_id: null, every: 5 } })).isError).toBeUndefined()
    expect((await client.callTool({ name: tool.name, arguments: {} })).isError).toBeUndefined()
    expect(inputs).toEqual([{ model_id: null, every: 5, report: true }, { report: true }])
    // A real bound is still enforced.
    expect((await client.callTool({ name: tool.name, arguments: { every: 0 } })).isError).toBe(true)
    await client.close()
  })

  test('sample calls to real tools still parse against their full fields', () => {
    const samples: Array<[string, object]> = [
      ['create_automation', { name: 'Nightly', prompt: 'Check CI', model_id: null, trigger: { type: 'interval', every_minutes: 60 } }],
      ['start_session', { prompt: 'Go', task: 'none', model_id: 'claude-opus-5' }],
      ['query_insights', { sql: 'select 1' }],
      ['list_tasks', {}],
    ]
    for (const [name, input] of samples) {
      const agentTool = toolbox.find((candidate) => candidate.name === name)
      expect(agentTool, name).toBeDefined()
      expect(z.object(agentTool!.inputFields).safeParse(input).success, name).toBe(true)
    }
  })
})

// WHY: tool context grows one description at a time and nothing notices. A
// change that makes it larger must raise this budget on purpose; a change that
// makes it smaller should lower it, so the saving holds.
describe('agent context budget', () => {
  test('the Solus tool list stays within the budget for each provider', async () => {
    const { client, tools } = await claudeListing(toolbox)
    const measured = {
      claudeToolListJsonBytes: toolListBytes(tools),
      codexToolListJsonBytes: toolListBytes(codexListing(toolbox)),
    }
    await client.close()
    expect(measured.claudeToolListJsonBytes).toBeLessThanOrEqual(budget.claudeToolListJsonBytes)
    expect(measured.codexToolListJsonBytes).toBeLessThanOrEqual(budget.codexToolListJsonBytes)
  })
})
