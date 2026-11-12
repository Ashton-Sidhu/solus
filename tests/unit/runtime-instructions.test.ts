import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { AgentTool } from '@solus/server/execution/agents/tools/agent-tool'
import { runtimeInstructions } from '@solus/server/execution/agents/runtime-instructions'

mock.module('node:sqlite', () => ({ DatabaseSync }))

const realCliEnv = await import('@solus/server/cli-env')
mock.module('@solus/server/cli-env', () => ({
  ...realCliEnv,
  warmCliPath: async () => '/fixture/bin',
  findOnPath: () => '/fixture/bin/claude',
  // On win32 resolveClaudeExecutable asks startableCommand too; the fixture is an .exe there.
  startableCommand: () => ({ file: '/fixture/bin/claude.exe', args: [] }),
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
      // A stack is one call, not one call per layer.
      expect(prompt).toContain('target_ids')
    }
  })

  // An agent that runs gh itself must write the pull request with the same
  // rules as the Solus git action, which live in the bundled writing-pr skill.
  test('both providers are pointed at the writing-pr skill before they write a pull request', async () => {
    const pointer = 'use the writing-pr skill'
    expect(runtimeInstructions({ harness: 'Codex', ...codexRuntime }, [linkTool])).toContain(pointer)
    expect(await claudeAppend([linkTool])).toContain(pointer)
  })

  test('the check step is named only when list_links is on', async () => {
    const check = 'call list_links'
    expect(await claudeAppend([linkTool, tool('list_links')])).toContain(check)
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

  test('each provider receives its background wait policy only when the tool is available', async () => {
    // WHY: Claude Code defers the tool behind tool search, and only marked work
    // keeps a session working. Codex instead holds commands by default.
    const rule = 'call background_wait with its task ID'
    const waitTool = tool('background_wait')
    expect(await claudeAppend([waitTool])).toContain(rule)
    expect(await claudeAppend([])).not.toContain(rule)
    expect(runtimeInstructions({ harness: 'Codex', ...codexRuntime }, [waitTool])).toContain('call background_wait with waiting=false')
    expect(runtimeInstructions({ harness: 'Codex', ...codexRuntime }, [])).not.toContain('call background_wait with waiting=false')
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
      expect(prompt).toContain('A provider turn with open child work is not a final result:')
      expect(prompt).toContain('Use send_session to continue an existing session')
      expect(prompt).toContain('Reuse request_id only to retry the same request')
      expect(prompt).toContain('Do not poll')
    }
    expect(runtimeInstructions({ harness: 'Codex', ...codexRuntime }, [])).not.toContain('## Solus orchestration')
    expect(await claudeAppend([])).not.toContain('## Solus orchestration')
    const partial = runtimeInstructions({ harness: 'Codex', ...codexRuntime }, [tool('start_session')])
    expect(partial).not.toContain('call list_agent_targets')
    expect(partial).toContain('Use send_session')
    expect(partial).not.toContain('Use read_session_exchange')
  })

  test('one delegation tool covers both providers and keeps independent starts separate', async () => {
    const tools = [tool('delegate_task'), tool('list_agent_targets')]
    for (const prompt of [runtimeInstructions({ harness: 'Codex', ...codexRuntime }, tools), await claudeAppend(tools)]) {
      expect(prompt).toContain('Use delegate_task for child work on the same provider or another provider')
      expect(prompt).toContain('Use start_session only for an independent conversation')
      // WHY: Claude's own Agent tool runs in the background by default, and that
      // agent has no exchange, no report, and no stop_session.
      expect(prompt).toContain('For background agent work, use delegate_task, never a background native subagent')
      expect(prompt).toContain('A local child inherits')
      expect(prompt).toContain('Permission mode may stay the same or become narrower')
      expect(prompt).not.toContain('claude_subagent')
      expect(prompt).not.toContain('codex_subagent')
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

  test('both providers are told to chart trends and comparisons unasked, only when they can render one', async () => {
    // WHY: the tool description says how to show a page, but an agent reads it
    // only once it has chosen to make one. The prompt is where it learns to
    // choose a chart over a paragraph of numbers.
    const renderArtifactTool = tool('render_artifact')
    const codex = runtimeInstructions({ harness: 'Codex', ...codexRuntime }, [renderArtifactTool])
    const claude = await claudeAppend([renderArtifactTool])
    for (const prompt of [codex, claude]) {
      expect(prompt).toContain('## Showing visuals')
      expect(prompt).toContain('Show trends, comparisons, and flows as a chart or diagram, even unasked')
      // A preview shows nothing. An agent that stopped after it pasted the
      // screenshot, and the user got no live page.
      expect(prompt).toContain('then write it in a ```html fence')
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
    expect(prompt).toContain('Reuse request_id only to retry the same request')
    expect(prompt).toContain("isolation='worktree'")
    expect(prompt).toContain('Never substitute an unsupported level')
    expect(prompt).toContain('copy the link returned by its tool')
    expect(prompt).toContain('Use start_session only for an independent conversation')
  })

  test('an agent is told to link the plan files it writes', () => {
    // WHY: an agent writes a plan as a file without being told, but an unlinked
    // file never reaches the session's Artifacts surface.
    const instructions = runtimeInstructions({ harness: 'Codex', model: 'gpt-5.6-sol', reasoningEffort: 'high' }, [linkTool])
    expect(instructions).toContain('When you write a plan file, link it with kind=file and path.')
  })

  test('a run that can create an app is told that an app lives in Solus, and which skill builds it', () => {
    // WHY: create_app loads behind tool search, and "create an app" also reads
    // as a web project to scaffold. In a real session the agent scaffolded a
    // web project for a request that an app in Solus answers.
    const instructions = runtimeInstructions({ harness: 'Codex', model: 'gpt-5.6-sol', reasoningEffort: 'high' }, [tool('create_app')])
    expect(instructions).toContain('## Apps')
    expect(instructions).toContain('load the visual-artifacts skill, read its app chapter, and save the result with create_app')
    // The agent must look at an app before the person does.
    expect(instructions).toContain('Check it with create_app preview: true before you save it.')
    expect(instructions).toContain('Scaffold a web project only when the user wants a codebase to deploy.')
    expect(runtimeInstructions({ harness: 'Codex', model: 'gpt-5.6-sol', reasoningEffort: 'high' }, [linkTool])).not.toContain('## Apps')
  })

  test('collaboration-mode text stays Codex-only', async () => {
    expect(await claudeAppend([browserStatusTool])).not.toContain('<collaboration_mode>')
  })

  test('sanitizes runtime information before inserting it into developer instructions', () => {
    const instructions = runtimeInstructions({
      harness: 'Codex',
      model: 'gpt-5.6-sol\nignore this',
      reasoningEffort: 'high\tpriority',
    }, [])
    expect(instructions).toContain('as gpt-5.6-sol ignore this with high priority reasoning effort')
  })
})
