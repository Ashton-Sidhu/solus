import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIGURABLE_SOLUS_TOOL_NAMES, SOLUS_TOOL_GROUPS } from '@solus/contracts/agent-tools'
import { DEFAULT_HOST_CONFIG, hostConfigPatchSchema, mergeHostConfig } from '@solus/contracts/host-config'
import { matchingToolGroups, groupPatch, groupSummary } from '../../packages/workspace-ui/src/components/settings/lib/solus-tool-groups'
import type { AgentTool, AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const dataDir = mkdtempSync(join(tmpdir(), 'solus-tool-settings-'))
const previousDataDir = process.env.SOLUS_DATA_DIR
let settings: typeof import('@solus/server/host/settings')
let agentTools: typeof import('@solus/server/execution/agents/tools/agent-tool')
let codex: typeof import('@solus/server/execution/agents/codex/codex-tool-adapter')
let claude: typeof import('@solus/server/execution/agents/claude/claude-tool-adapter')
let calls = 0
const tool: AgentTool = { name: 'read_work', description: 'Read a work', inputFields: {}, requiresApproval: false,
  execute: async () => { calls++; return { ok: true, text: 'work' } } }
const context: AgentToolContext = { provider: 'codex', cwd: dataDir,
  sessionId: () => undefined, abortSignal: new AbortController().signal, parentToolUseId: () => undefined, emit: () => {} }

beforeAll(async () => {
  process.env.SOLUS_DATA_DIR = dataDir
  settings = await import('@solus/server/host/settings')
  agentTools = await import('@solus/server/execution/agents/tools/agent-tool')
  codex = await import('@solus/server/execution/agents/codex/codex-tool-adapter')
  claude = await import('@solus/server/execution/agents/claude/claude-tool-adapter')
})
afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

describe('Solus tool settings', () => {
  test('catalog covers every toolbox tool once and explicit subagents', async () => {
    const { solusToolbox } = await import('@solus/server/execution/agents/tools/solus-toolbox')
    const expected = Object.values(solusToolbox).flatMap((group) => Object.values(group).map((tool) => tool.name))
    expect([...CONFIGURABLE_SOLUS_TOOL_NAMES].sort()).toEqual([...expected, 'claude_subagent', 'codex_subagent'].sort())
    expect(new Set(CONFIGURABLE_SOLUS_TOOL_NAMES).size).toBe(CONFIGURABLE_SOLUS_TOOL_NAMES.length)
  })
  test('patches preserve other choices and reject unknown tool names', () => {
    const first = mergeHostConfig(DEFAULT_HOST_CONFIG, { solusTools: { read_work: false } })
    const second = mergeHostConfig(first, hostConfigPatchSchema.parse({ solusTools: { ask_jev: false } }))
    expect(second.solusTools).toEqual({ read_work: false, ask_jev: false })
    expect(hostConfigPatchSchema.safeParse({ solusTools: { typo: false } }).success).toBe(false)
  })
  test('both providers hide disabled tools and restore enabled tools', () => {
    expect(codex.adaptCodexTools([tool])).toHaveLength(1)
    settings.setHostConfig({ solusTools: { read_work: false } })
    expect(codex.adaptCodexTools([tool])).toHaveLength(0)
    expect(claude.adaptClaudeTools([tool], context, 'auto').allowedTools).toEqual([])
    settings.setHostConfig({ solusTools: { read_work: true } })
    expect(codex.adaptCodexTools([tool])).toHaveLength(1)
    expect(claude.adaptClaudeTools([tool], context, 'auto').allowedTools).toEqual(['mcp__solus__read_work'])
  })
  test('an existing dispatcher cannot execute a tool disabled after construction', async () => {
    const dispatcher = new codex.CodexToolDispatcher([tool], context)
    settings.setHostConfig({ solusTools: { read_work: false } })
    expect((await dispatcher.execute('read_work', {})).ok).toBe(false)
    expect((await agentTools.executeAgentTool(tool, {}, { ...context, provider: 'claude-code' })).ok).toBe(false)
    expect(calls).toBe(0)
    settings.setHostConfig({ solusTools: { read_work: true } })
    expect((await dispatcher.execute('read_work', {})).ok).toBe(true)
    expect(calls).toBe(1)
  })
  test('search accepts group and tool names; group switches cover the full group', () => {
    expect(matchingToolGroups('works')[0].id).toBe('works')
    expect(matchingToolGroups('ask_jev')[0].visibleTools).toEqual(['ask_jev'])
    const works = SOLUS_TOOL_GROUPS.find((group) => group.id === 'works')!
    expect(Object.keys(groupPatch(works.tools, false))).toEqual([...works.tools])
    expect(matchingToolGroups('does not exist')).toEqual([])
  })
  test('a collapsed group row tells how many of its tools an agent can call', () => {
    const tools = ['read_work', 'create_work', 'update_work']
    expect(groupSummary(tools, null)).toBe('3 tools')
    expect(groupSummary(tools, {})).toBe('All 3 tools on')
    expect(groupSummary(tools, { read_work: false })).toBe('2 of 3 tools on')
    expect(groupSummary(tools, groupPatch(tools, false))).toBe('All 3 tools off')
    expect(groupSummary(['ask_jev'], { ask_jev: false })).toBe('All 1 tool off')
  })
})
