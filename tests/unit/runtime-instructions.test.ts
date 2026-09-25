import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { AgentTool } from '@solus/server/agents/tools/agent-tool'
import { codexCollaborationInstructions } from '@solus/server/agents/codex/codex-collaboration-instructions'
import { runtimeInstructions } from '@solus/server/agents/runtime-instructions'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const realCliEnv = await import('@solus/server/cli-env')
mock.module('@solus/server/cli-env', () => ({
  ...realCliEnv,
  warmCliPath: async () => '/fixture/bin',
  findOnPath: () => '/fixture/bin/claude',
}))

let capturedOptions: Options | null = null
const realSdk = await import('@anthropic-ai/claude-agent-sdk')
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: ({ options }: { options: Options }) => {
    capturedOptions = options
    return (async function* () {})()
  },
}))

let ClaudeBackend: typeof import('@solus/server/agents/claude/claude-backend')['ClaudeBackend']
beforeAll(async () => {
  ;({ ClaudeBackend } = await import('@solus/server/agents/claude/claude-backend'))
})

const MEDIA_LINE = 'You can embed images and videos in your response with Markdown and absolute file paths.'
const BROWSER_HEADING = '## Solus collaborative browser'

const browserStatusTool = {
  name: 'browser_status',
  description: 'Report the browser.',
  inputSchema: {},
  execute: async () => ({ ok: true, text: '' }),
} as unknown as AgentTool

/** The system prompt append Claude receives for one run with these tools. */
async function claudeAppend(tools: AgentTool[], systemPrompt?: string): Promise<string> {
  capturedOptions = null
  const backend = new ClaudeBackend()
  backend.on('error', () => {})
  const handle = backend.startRun({
    provider: 'claude-code', prompt: 'hello', cwd: '/tmp', tools, systemPrompt,
    model: 'claude-opus-4-7', reasoningEffort: 'high',
    permissionMode: 'ask', persistence: 'ephemeral', service: 'sessions',
    conversation: { kind: 'new' },
  })
  await handle.runPromise.catch(() => {})
  const prompt = capturedOptions?.systemPrompt
  if (!prompt || typeof prompt === 'string' || Array.isArray(prompt)) throw new Error('expected a preset system prompt')
  return prompt.append ?? ''
}

describe('runtime instructions', () => {
  // WHY: both providers must get the same host facts. Before this, Claude got
  // none of them, so it never knew Solus renders media or shares a browser.
  test('Claude and Codex receive the same runtime block', async () => {
    const shared = runtimeInstructions({ harness: 'Codex', model: 'gpt-5.6-sol', reasoningEffort: 'high' }, true)
    expect(codexCollaborationInstructions('default', { model: 'gpt-5.6-sol', reasoningEffort: 'high' }, true)).toContain(shared)
    expect(codexCollaborationInstructions('plan', { model: 'gpt-5.6-sol', reasoningEffort: 'medium' }, true)).toContain(MEDIA_LINE)

    const claude = await claudeAppend([browserStatusTool])
    expect(claude).toContain('<runtime_info>')
    expect(claude).toContain('through the Claude Code harness')
    expect(claude).toContain('with high reasoning effort')
    expect(claude).toContain(MEDIA_LINE)
    expect(claude).toContain(BROWSER_HEADING)
  })

  test('the user instructions come first and are kept', async () => {
    const claude = await claudeAppend([], 'User extra instructions:\nBe terse.')
    expect(claude.startsWith('User extra instructions:\nBe terse.\n\n<runtime_info>')).toBe(true)
  })

  test('the browser block is absent when the Browser tool group is off', async () => {
    expect(codexCollaborationInstructions('default', { model: 'gpt-5.6-sol', reasoningEffort: 'high' }, false)).not.toContain(BROWSER_HEADING)
    const claude = await claudeAppend([])
    expect(claude).toContain(MEDIA_LINE)
    expect(claude).not.toContain(BROWSER_HEADING)
  })

  test('collaboration-mode text stays Codex-only', async () => {
    expect(await claudeAppend([browserStatusTool])).not.toContain('<collaboration_mode>')
  })
})
