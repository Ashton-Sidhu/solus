import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { AgentTool } from '@solus/server/execution/agents/tools/agent-tool'
import { runtimeInstructions } from '@solus/server/execution/agents/runtime-instructions'

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

let ClaudeBackend: typeof import('@solus/server/execution/agents/claude/claude-backend')['ClaudeBackend']
beforeAll(async () => {
  ;({ ClaudeBackend } = await import('@solus/server/execution/agents/claude/claude-backend'))
})

const MEDIA_LINE = 'You can embed images and videos in your response with Markdown and absolute file paths.'
const BROWSER_HEADING = '## Solus collaborative browser'
const PR_LINKING_HEADING = '## Pull request linking'

function tool(name: string): AgentTool {
  return {
    name,
    description: name,
    inputFields: {},
    requiresApproval: false,
    execute: async () => ({ ok: true, text: '' }),
  }
}
const browserStatusTool = tool('browser_status')
const linkTool = tool('link')
const codexRuntime = { model: 'gpt-5.6-sol', reasoningEffort: 'high' }

/** The system prompt append Claude receives for one run with these tools. */
async function claudeAppend(tools: AgentTool[], systemPrompt?: string, cwd = '/tmp'): Promise<string> {
  capturedOptions = null
  const backend = new ClaudeBackend()
  backend.on('error', () => {})
  const handle = backend.startRun({
    provider: 'claude-code', prompt: 'hello', cwd, tools, systemPrompt,
    model: 'claude-opus-4-7', reasoningEffort: 'high',
    permissionMode: 'supervised', persistence: 'ephemeral', service: 'sessions',
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
    const shared = runtimeInstructions({ harness: 'Codex', ...codexRuntime }, [browserStatusTool])
    expect(shared).toContain(MEDIA_LINE)
    expect(runtimeInstructions({ harness: 'Codex', model: 'gpt-5.6-sol', reasoningEffort: 'medium' }, [browserStatusTool])).toContain(MEDIA_LINE)

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
    expect(runtimeInstructions({ harness: 'Codex', ...codexRuntime }, [])).not.toContain(BROWSER_HEADING)
    const claude = await claudeAppend([])
    expect(claude).toContain(MEDIA_LINE)
    expect(claude).not.toContain(BROWSER_HEADING)
  })

  // WHY: an agent whose Solus browser calls kept failing on an open page, or
  // whose user invoked a workflow that names another browser, stopped to ask
  // which browser to use. The Solus browser stays the default, but those two
  // cases must let the agent continue without a question.
  test('the browser rule lets an agent fall back after repeated failures or a named workflow', () => {
    const prompt = runtimeInstructions({ harness: 'Codex', ...codexRuntime }, [browserStatusTool])
    expect(prompt).toContain('invokes a skill or documented repository workflow that names one')
    expect(prompt).toContain('fail twice on the same step')
    expect(prompt).toContain('switch without asking the user which browser to use')
  })

  // WHY: Solus sees a pull request on the session's own branch, or one its own
  // git action opened. One the agent opens with gh, on another branch, or as a
  // stack layer stays unlinked unless the agent calls link. Every session needs
  // that rule, not only a session that works on a task.
  test('both providers are told to link each pull request when link is available', async () => {
    const codex = runtimeInstructions({ harness: 'Codex', ...codexRuntime }, [linkTool])
    const claude = await claudeAppend([linkTool])
    for (const prompt of [codex, claude]) {
      expect(prompt).toContain(PR_LINKING_HEADING)
      expect(prompt).toContain('Call link with kind=pr')
      expect(prompt).toContain('link every layer')
    }
  })

  // An agent that runs gh itself must write the pull request with the same
  // rules as the Solus git action, which live in the bundled writing-pr skill.
  test('both providers are pointed at the writing-pr skill before they write a pull request', async () => {
    const pointer = 'use the writing-pr skill'
    expect(runtimeInstructions({ harness: 'Codex', ...codexRuntime }, [linkTool])).toContain(pointer)
    expect(await claudeAppend([linkTool])).toContain(pointer)
  })

  test('the check step is named only when list_session_pull_requests is on', async () => {
    const check = 'call list_session_pull_requests'
    expect(await claudeAppend([linkTool, tool('list_session_pull_requests')])).toContain(check)
    expect(await claudeAppend([linkTool])).not.toContain(check)
  })

  test('an agent with watch_pull_request is told to end its turn instead of polling, on both providers', async () => {
    // WHY: the tool description loads behind tool search; without this block
    // an agent polls `gh pr checks` in a loop before it ever finds the tool.
    const rule = 'call watch_pull_request and end your turn'
    const watchTool = tool('watch_pull_request')
    expect(runtimeInstructions({ harness: 'Codex', ...codexRuntime }, [linkTool, watchTool])).toContain(rule)
    expect(await claudeAppend([linkTool, watchTool])).toContain(rule)
    expect(await claudeAppend([linkTool])).not.toContain(rule)
  })

  test('the pull request block is absent when the Tasks tool group is off', async () => {
    expect(runtimeInstructions({ harness: 'Codex', ...codexRuntime }, [browserStatusTool])).not.toContain(PR_LINKING_HEADING)
    expect(await claudeAppend([browserStatusTool])).not.toContain(PR_LINKING_HEADING)
  })

  test('shared orchestration guidance is present for both providers only with session tools', async () => {
    const tools = ['start_session', 'send_session', 'list_agent_targets', 'read_session_exchange'].map(tool)
    const codex = runtimeInstructions({ harness: 'Codex', ...codexRuntime }, tools)
    const claude = await claudeAppend(tools)
    for (const prompt of [codex, claude]) {
      expect(prompt).toContain('## Solus orchestration')
      expect(prompt).toContain('This catalog does not establish native subagent support')
      expect(prompt).toContain('An ended provider turn with open child work is not a final result.')
      expect(prompt).toContain('Use send_session to continue an existing session')
      expect(prompt).toContain('reuse it only when retrying that same work')
      expect(prompt).toContain('Do not poll in a loop')
    }
    expect(runtimeInstructions({ harness: 'Codex', ...codexRuntime }, [])).not.toContain('## Solus orchestration')
    expect(await claudeAppend([])).not.toContain('## Solus orchestration')
    const partial = runtimeInstructions({ harness: 'Codex', ...codexRuntime }, [tool('start_session')])
    expect(partial).not.toContain('call list_agent_targets')
    expect(partial).not.toContain('Use send_session')
    expect(partial).not.toContain('Use read_session_exchange')
  })

  test('delegation guidance keeps model changes and task mode separate from native subagents', async () => {
    const tools = [tool('start_session'), tool('list_agent_targets')]
    for (const prompt of [runtimeInstructions({ harness: 'Codex', ...codexRuntime }, tools), await claudeAppend(tools)]) {
      expect(prompt).toContain('A different model alone does not require start_session')
      expect(prompt).toContain('Native subagents need no Solus task fields')
      expect(prompt).toContain("Use task='none' outside task mode")
      expect(prompt).toContain('In task mode, follow the Working On Task packet')
      expect(prompt).not.toContain('File related work as task=attempt')
      expect(prompt).not.toContain('claude_subagent is available')
      expect(prompt).not.toContain('codex_subagent is available')
    }
  })

  test('only the available wrapper is named before tool selection', async () => {
    for (const wrapper of ['claude_subagent', 'codex_subagent']) {
      const tools = [tool('start_session'), tool(wrapper)]
      for (const prompt of [runtimeInstructions({ harness: 'Codex', ...codexRuntime }, tools), await claudeAppend(tools)]) {
        expect(prompt).toContain(`${wrapper} is available for temporary work`)
        expect(prompt).toContain('no Solus report or task fields are needed')
        const other = wrapper === 'claude_subagent' ? 'codex_subagent' : 'claude_subagent'
        expect(prompt).not.toContain(`${other} is available`)
      }
    }
  })

  // WHY: a chat's folder is a scratch folder the person never sees. An agent
  // that names its path or runs Git there turns a plain chat back into a
  // technical tool (docs/plans/projectless-chat.md).
  test('both providers learn a chat is a chat, and a project session does not', async () => {
    const chatFolder = '/Users/me/.solus/solus-chats/session-1'
    const codex = runtimeInstructions({ harness: 'Codex', ...codexRuntime, workingDirectory: chatFolder }, [])
    const claude = await claudeAppend([], undefined, chatFolder)
    for (const prompt of [codex, claude]) {
      expect(prompt).toContain('## Chat')
      expect(prompt).toContain('Do not mention its path')
    }
    expect(runtimeInstructions({ harness: 'Codex', ...codexRuntime, workingDirectory: '/Users/me/projects/solus' }, [])).not.toContain('## Chat')
    expect(await claudeAppend([])).not.toContain('## Chat')
  })

  test('both providers are told when a visual says more than prose, only when they can render one', async () => {
    // WHY: the tool description says how to show a page, but an agent reads it
    // only once it has chosen to make one. The prompt is where it learns to
    // choose a chart over a paragraph of numbers.
    const renderArtifactTool = tool('render_artifact')
    const codex = runtimeInstructions({ harness: 'Codex', ...codexRuntime }, [renderArtifactTool])
    const claude = await claudeAppend([renderArtifactTool])
    for (const prompt of [codex, claude]) {
      expect(prompt).toContain('## Showing visuals')
      expect(prompt).toContain('would say more than prose')
    }
    expect(runtimeInstructions({ harness: 'Codex', ...codexRuntime }, [])).not.toContain('## Showing visuals')
  })

  test('the device and automation blocks reach both providers only with their tools', async () => {
    // WHY: guidance for tools a run does not have talks the agent out of the
    // automation it still has (raw simctl, a background wait).
    const deviceListTool = tool('device_list')
    const createAutomationTool = tool('create_automation')
    const codex = runtimeInstructions({ harness: 'Codex', ...codexRuntime }, [deviceListTool, createAutomationTool])
    const claude = await claudeAppend([deviceListTool, createAutomationTool])
    for (const prompt of [codex, claude]) {
      expect(prompt).toContain('## Solus devices')
      expect(prompt).toContain('pass its flags on every command')
      expect(prompt).toContain('## Automations')
      expect(prompt).toContain('Pass trigger as an object, never as JSON text')
    }
    const without = runtimeInstructions({ harness: 'Codex', ...codexRuntime }, [browserStatusTool])
    expect(without).not.toContain('## Solus devices')
    expect(without).not.toContain('## Automations')
  })

  test('the browser block sends the agent to the page the user has open', () => {
    // WHY: "look at this page" means the user's page. A second page on the same
    // URL loses their state and signs in as the default profile.
    const prompt = runtimeInstructions({ harness: 'Codex', ...codexRuntime }, [browserStatusTool])
    expect(prompt).toContain('including the pages the user opened')
    expect(prompt).toContain("use that page's browserPageId")
  })

  test('orchestration guidance covers retries, workspaces, model options, and session links', () => {
    // WHY: each rule stops a real failure: a lost response that starts a second
    // session, a stacked branch that starts without its local commits, a
    // requested reasoning level that is silently lowered, and a session named
    // by id where the user cannot open it.
    const prompt = runtimeInstructions({ harness: 'Codex', ...codexRuntime }, [tool('start_session')])
    expect(prompt).toContain('retry with the same request_id')
    expect(prompt).toContain('Push the base branch first')
    expect(prompt).toContain('Do not change a requested level to another one')
    expect(prompt).toContain('session://open?provider=')
    expect(prompt).toContain('Do not use start_session only because the user said "subagent"')
  })

  test('collaboration-mode text stays Codex-only', async () => {
    expect(await claudeAppend([browserStatusTool])).not.toContain('<collaboration_mode>')
  })
})
