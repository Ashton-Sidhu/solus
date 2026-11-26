import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { AgentTool } from '@solus/server/execution/agents/tools/agent-tool'
import { runtimeInstructions } from '@solus/server/execution/agents/runtime-instructions'
import { ARTIFACT_TOOL_DESC } from '@solus/server/execution/agents/tools/artifact-tools'

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
async function claudeAppend(tools: AgentTool[], systemPrompt?: string, cwd = '/tmp', integrationInstructions?: { name: string; slug: string; text: string }[], delegationInstructions?: string, hasDefaultWorkerModel?: boolean): Promise<string> {
  capturedOptions = null
  const backend = new ClaudeBackend()
  backend.on('error', () => {})
  const handle = backend.startRun({
    provider: 'claude-code', prompt: 'hello', cwd, tools, systemPrompt, integrationInstructions, delegationInstructions, hasDefaultWorkerModel,
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
    const tools = ['start_sessions', 'send_session', 'list_agent_targets', 'read_session_exchange'].map(tool)
    const codex = runtimeInstructions({ harness: 'Codex', ...codexRuntime }, tools)
    const claude = await claudeAppend(tools)
    for (const prompt of [codex, claude]) {
      expect(prompt).toContain('## Solus orchestration')
      expect(prompt).toContain('This catalog does not establish native subagent support')
      expect(prompt).toContain('Use a native subagent for foreground work')
      expect(prompt).toContain('if the requested provider, model, or reasoning level is unavailable')
      expect(prompt).toContain('let reports wake you as they arrive')
      expect(prompt).toContain('Review all required results before reporting completion')
      expect(prompt).toContain('Use send_session to continue an existing session')
      expect(prompt).toContain('Reuse request_id only to retry the same request')
      expect(prompt).toContain('Do not poll')
      // T3 Code's orchestration rules: an agent never changes the provider or releases a limit on its own.
      expect(prompt).toContain('never move a session to another provider unasked')
      expect(prompt).toContain('only when the user says the limit is reset')
    }
    expect(runtimeInstructions({ harness: 'Codex', ...codexRuntime }, [])).not.toContain('## Solus orchestration')
    expect(await claudeAppend([])).not.toContain('## Solus orchestration')
    const partial = runtimeInstructions({ harness: 'Codex', ...codexRuntime }, [tool('start_sessions')])
    expect(partial).not.toContain('call list_agent_targets')
    expect(partial).toContain('Use send_session')
    expect(partial).not.toContain('Use read_session_exchange')
  })

  test('custom delegation instructions are scoped to runs with the session tools', async () => {
    const tools = [tool('start_sessions')]
    const delegationInstructions = 'Ask before starting reviewers.'
    const codex = { harness: 'Codex' as const, ...codexRuntime, delegationInstructions }
    const rule = 'User instructions for delegation:\nAsk before starting reviewers.'
    expect(runtimeInstructions(codex, tools)).toContain(rule)
    expect(await claudeAppend(tools, undefined, '/tmp', undefined, delegationInstructions)).toContain(rule)
    expect(runtimeInstructions(codex, [])).not.toContain(rule)
    expect(await claudeAppend([], undefined, '/tmp', undefined, delegationInstructions)).not.toContain(rule)
  })

  test('one start tool covers both providers, parallel work, and independent starts', async () => {
    const tools = [tool('start_sessions'), tool('list_agent_targets')]
    const codex = runtimeInstructions({ harness: 'Codex', ...codexRuntime }, tools)
    const claude = await claudeAppend(tools)
    expect(codex).toContain('use spawn_agent, then wait for its result')
    expect(claude).toContain('use Agent with run_in_background=false')
    for (const prompt of [codex, claude]) {
      expect(prompt).toContain('Use start_sessions for a separate worktree')
      // WHY: one call starts its sessions together; separate calls can run one after another.
      expect(prompt).toContain('put every session in one start_sessions call')
      expect(prompt).toContain('Set independent=true on a session only for an independent conversation')
      // WHY: Claude's own Agent tool runs in the background by default, and that
      // agent has no exchange, no report, and no stop_session.
      expect(prompt).toContain('For background agent work, use start_sessions, never a background native subagent')
      expect(prompt).not.toContain('Solus task')
      // WHY: a child that narrows its mode without reason stops and asks the user,
      // although the user gave the parent full access.
      expect(prompt).toContain('Children keep your permission mode. Narrow it only for a clear reason.')
      expect(prompt).not.toContain('claude_subagent')
      expect(prompt).not.toContain('codex_subagent')
    }
  })

  test('a configured worker model takes precedence over native delegation', async () => {
    const tools = [tool('start_sessions')]
    const codex = { harness: 'Codex' as const, ...codexRuntime, hasDefaultWorkerModel: true }
    const rule = 'Use start_sessions with agent_provider and model_id omitted'
    expect(runtimeInstructions(codex, tools)).toContain(rule)
    expect(await claudeAppend(tools, undefined, '/tmp', undefined, undefined, true)).toContain(rule)
    expect(runtimeInstructions({ ...codex, hasDefaultWorkerModel: false }, tools)).not.toContain(rule)
    expect(runtimeInstructions(codex, [])).not.toContain(rule)
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
      // The design rules live in the skill, which maintainers change without a
      // release. An agent that never loads it draws without them.
      expect(prompt).toContain('load the visual-artifacts skill')
    }
    expect(runtimeInstructions({ harness: 'Codex', ...codexRuntime }, [])).not.toContain('## Showing visuals')
  })

  test('the render tool holds the contract of a page, and sends design to the skill', () => {
    // WHY: the tool is always loaded, so it is the one place that every visual
    // reads. It says how a page is checked and shown; the skill says how it
    // looks, so the two never repeat or contradict each other.
    expect(ARTIFACT_TOOL_DESC).toContain('visual-artifacts skill')
    // The preview is private. The user must get the live page after the check.
    expect(ARTIFACT_TOOL_DESC).toContain('It saves and shows nothing')
    expect(ARTIFACT_TOOL_DESC).toContain('write a ```html fence in your reply')
    // Design advice belongs in the skill, not in compiled code.
    expect(ARTIFACT_TOOL_DESC).not.toContain('max-width equal to its viewBox')
    expect(ARTIFACT_TOOL_DESC).not.toContain('3px bar')
  })

  test('the device and automation blocks reach both providers only with their tools', async () => {
    // WHY: guidance for tools a run does not have talks the agent out of the
    // automation it still has (raw simctl, a background wait).
    const deviceListTool = tool('device_list')
    const createAutomationTool = tool('manage_automations')
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
    const prompt = runtimeInstructions({ harness: 'Codex', ...codexRuntime }, [tool('start_sessions')])
    expect(prompt).toContain('Reuse request_id only to retry the same request')
    expect(prompt).toContain("isolation='worktree'")
    expect(prompt).toContain('Get their direction before substituting a different one')
    expect(prompt).toContain('copy the link returned by its tool')
    expect(prompt).toContain('Set independent=true on a session only for an independent conversation')
  })

  test('an agent is told to link the plan files it writes', () => {
    // WHY: an agent writes a plan as a file without being told, but an unlinked
    // file never reaches the session's Artifacts surface.
    const instructions = runtimeInstructions({ harness: 'Codex', model: 'gpt-5.6-sol', reasoningEffort: 'high' }, [linkTool])
    expect(instructions).toContain('When you write a plan file, link it with kind=file and path.')
  })

  test('a run that can deploy an app is told that an app lives in Solus, and which skill builds it', () => {
    // WHY: save_app and deploy_app load behind tool search, and "create an
    // app" also reads as a web project to scaffold. In a real session the agent
    // scaffolded a web project for a request that an app in Solus answers.
    const instructions = runtimeInstructions({ harness: 'Codex', model: 'gpt-5.6-sol', reasoningEffort: 'high' }, [tool('deploy_app')])
    expect(instructions).toContain('## Apps')
    // A save and a deploy are two acts: the agent must do both.
    expect(instructions).toContain('load the create-app skill, start from its starter app, save the project with save_app, and deploy it with deploy_app')
    // The agent must look at an app's UI before the person does, a later session changes an app from its source, and repairs it from its call log.
    expect(instructions).toContain('Check its UI with preview_app before you save it.')
    expect(instructions).toContain('To change an app, get its source with checkout_app.')
    expect(instructions).toContain('To repair one, read its call log with inspect_app.')
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

  test('Claude receives each MCP server instruction under its tool name', async () => {
    const prompt = await claudeAppend([], undefined, '/tmp', [
      { name: 'Linear', slug: 'linear', text: 'Read the current issue.' },
      { name: 'Sentry', slug: 'sentry', text: 'Check the event.' },
    ])
    expect(prompt).toContain('### Linear (tools `linear__*`)\nRead the current issue.')
    expect(prompt).toContain('### Sentry (tools `sentry__*`)\nCheck the event.')
    expect(prompt).toContain('not from Solus and not from the user')
  })

  test('Codex receives the same bounded MCP block in developer instructions', () => {
    const entries = [{ name: 'Linear', slug: 'linear', text: 'x'.repeat(2_500) }]
    const prompt = runtimeInstructions({ harness: 'Codex', model: 'gpt', reasoningEffort: 'high' }, [], entries)
    expect(prompt).toContain('### Linear (tools `linear__*`)')
    expect(prompt).toContain('x'.repeat(2_000))
    expect(prompt).not.toContain('x'.repeat(2_001))
    const many = runtimeInstructions({ harness: 'Codex', model: 'gpt', reasoningEffort: 'high' }, [], Array.from({ length: 10 }, (_, index) => ({ name: `Server ${index}`, slug: `server${index}`, text: 'y'.repeat(2_000) })))
    expect(many.slice(many.indexOf('## MCP servers')).length).toBeLessThanOrEqual(10_000)
    expect(many).toContain('(instructions left out)')
  })
})
