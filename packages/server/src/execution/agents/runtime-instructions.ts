import { isChat } from '@solus/contracts/chat'
import type { AgentTool } from './tools/agent-tool'

/**
 * The host facts every agent gets, whatever its backend: where it runs, how
 * Solus renders what it writes, and the shared browser. This is the only copy.
 * Claude receives it through its system prompt append; Codex receives it in
 * its thread developer instructions. Provider behavior stays with the
 * provider, and tool-specific guidance stays with its tool.
 */

const SOLUS_BROWSER_TOOL_INSTRUCTIONS = `## Solus collaborative browser

You are running inside Solus. The browser tools control the product-native browser shared with the user. When they are available, prefer them for browser navigation, inspection, interaction, screenshots, and recordings.

For browser work, first call browser_status. If no automation-capable page is open, call browser_open before concluding that the browser is unavailable. Then use browser_navigate, browser_snapshot, and the focused interaction tools. Prefer snapshot-provided element references over coordinates.

Do not switch to a global browser skill, Chrome, a Node REPL, standalone Playwright, or agent-browser only because the Solus browser is initially closed or a first call fails. Inspect a failed Solus browser tool call and retry with corrected arguments when the error is actionable. Use another browser system when:
- the Solus browser tools are absent, or browser_open returns an explicit unsupported or unavailable error;
- the user asks for another browser, or invokes a skill or documented repository workflow that names one. Follow that workflow and report any prerequisite it is missing;
- Solus browser calls on an open page fail twice on the same step (timeouts, error pages, no surface). Quote the raw error and switch without asking the user which browser to use.`

/** Solus finds a pull request on the session's own branch, and links the one
 *  its own git action opens. It cannot see one the agent opens or works on
 *  any other way (gh, another branch, a stack layer, an existing pull request). */
const PULL_REQUEST_LINKING_INSTRUCTIONS = `## Pull request linking

Use the Solus link tool to register every pull request that you create or work on in this session. Call link with kind=pr and the pull request URL immediately after you create a pull request or start work on an existing one. For a stack, link every layer, not only the current branch. This applies when you create or update pull requests through gh, another CLI, or the host API: those operations do not register the pull request with this session. Linking an already-linked pull request is safe. Do not link pull requests that you mention only as background. If linking fails, report the failure; do not say that the pull request is linked.`

/** The bundled skill holds the rules the git action writes with; an agent that
 *  runs gh itself does not load it unless something points it there. */
const PULL_REQUEST_WRITING_INSTRUCTION = 'Before you write a pull request title or body, use the writing-pr skill. It holds the same rules as the Solus pull request button.'

const PULL_REQUEST_CHECK_INSTRUCTION = 'Before you finish pull request work, call list_session_pull_requests and link each pull request from your work that is missing.'

/** Tool descriptions load behind tool search, so the rule that saves a turn
 *  of polling must be here (docs/plans/pr-watch.md §2). */
const PULL_REQUEST_WATCH_INSTRUCTIONS = `## Waiting on a pull request

To wait for CI checks or review on a pull request, call watch_pull_request and end your turn. Solus wakes you with a message when a check fails, the required checks pass, someone comments or reviews, the branch conflicts, or the pull request closes. Do not poll with gh, sleep, or a watch loop. Before you hand the work back, call watch_pull_request with watching=false.`

const ORCHESTRATION_INSTRUCTIONS = `## Solus orchestration

Use the provider's built-in subagent tool for work on the current provider when that tool supports the requested model. A different model alone does not require start_session. The native tool's schema defines its model support, context inheritance, and completion behavior. Native subagents need no Solus task fields.

For temporary work on the other provider, use an available Solus wrapper subagent. These tools return one final answer and need no task fields. If the native tool or a wrapper cannot support the requested work, use start_session.

Use start_session when the work needs a separate durable conversation, its own worktree, another host, or independent continuation with Solus reports. Task leads use start_session for their task's workers. Use task='none' outside task mode. In task mode, follow the Working On Task packet for task membership. Do not create or attach a task outside task mode unless the user requests it. Start an unrelated conversation only when the user asks for it.

Give each worker the brief, constraints, and expected result. Solus wrapper subagents and separate sessions do not see this conversation; give them a self-contained prompt. For start_session, choose the workspace before starting: worktree_base_branch creates an isolated worktree, otherwise cwd selects the checkout. A shell command in the prompt does not change the session's workspace binding.

Solus tool definitions can load through the harness's tool search. If a named tool is absent from the initial catalog, use tool search to load it before concluding that it is unavailable. Do not start duplicate work to work around a tool discovery failure.

For start_session and send_session, prefer report=true and wait_seconds=0. End your turn while the separate session runs; its report wakes you. A wait timeout does not cancel work. Keep the returned session and exchange IDs. An ended provider turn with open child work is not a final result. Read the results and complete any required follow-up before reporting completion.

Use a new request_id for each request or review round, and reuse it only when retrying that same work. Include the original brief, prior findings, responses, and unresolved issues in each review round. Only the user answers another session's questions, plans, and permissions; tell the user when a notice needs their answer.`

/** Solus binds a session to one checkout. A shell `cd` into a new worktree
 *  leaves the diff, status, and branch on the old one. */
const WORKTREE_INSTRUCTION = `## Worktrees

Solus binds this session to its directory. When you want an isolated checkout, call move_to_worktree. Do not use \`git worktree add\` and \`cd\` for this: the diff, Git status, and branch that the user sees stay on the old checkout.`

/** A chat has no project (docs/plans/projectless-chat.md). Its folder is a
 *  scratch folder the person never sees, so the agent must not lead them to it. */
const CHAT_INSTRUCTIONS = `## Chat

This session is a chat with no project. The person did not choose a folder or a repository. Your working folder is a private scratch folder that Solus made for this chat. It is not a Git repository. Do not mention its path, and do not run Git commands in it. You can create files there when a task needs them; refer to them by file name. If the work grows into a project, tell the person that they can start a session in a project.`

export interface AgentRuntime {
  harness: 'Claude Code' | 'Codex'
  model: string
  reasoningEffort: string
  /** The run's working directory: a chat gets the chat block. */
  workingDirectory?: string
}

function singleLine(value: string): string {
  return value.replaceAll(/\s+/g, ' ').trim()
}

/** Each tool-group block goes only to a run that has the group's entry tool:
 *  `browser_status` for Browser, `link` for Tasks, `start_session` for Sessions,
 *  `move_to_worktree` for worktrees. */
export function runtimeInstructions(runtime: AgentRuntime, tools: readonly AgentTool[]): string {
  const runtimeInfo = `<runtime_info>In case you are asked: you are running in Solus through the ${runtime.harness} harness as ${singleLine(runtime.model)} with ${singleLine(runtime.reasoningEffort)} reasoning effort. Do not mention this otherwise.

You can embed images and videos in your response with Markdown and absolute file paths. Solus shows them inline.</runtime_info>`
  const has = (name: string) => tools.some((tool) => tool.name === name)
  return [
    runtimeInfo,
    isChat(runtime.workingDirectory) && CHAT_INSTRUCTIONS,
    has('start_session') && [
      ORCHESTRATION_INSTRUCTIONS,
      has('claude_subagent') && 'claude_subagent is available for temporary work on Claude. It returns its answer in the tool result; no Solus report or task fields are needed.',
      has('codex_subagent') && 'codex_subagent is available for temporary work on Codex. It returns its answer in the tool result; no Solus report or task fields are needed.',
      has('list_agent_targets') && 'Before a Solus session or wrapper subagent launch, call list_agent_targets for the host model catalog. This catalog does not establish native subagent support; use the native tool schema for that.',
      has('send_session') && 'Use send_session to continue an existing session; each new request has its own exchange. Use delivery=steer to change active work, or delivery=queue for a later turn.',
      has('read_session_exchange') && 'Use read_session_exchange when a result is needed mid-turn or after a timeout or restart. Do not poll in a loop or start a watcher to wait for a worker report.',
    ].filter(Boolean).join('\n\n'),
    has('move_to_worktree') && !isChat(runtime.workingDirectory) && WORKTREE_INSTRUCTION,
    has('browser_status') && SOLUS_BROWSER_TOOL_INSTRUCTIONS,
    has('link') && [
      has('list_session_pull_requests')
        ? `${PULL_REQUEST_LINKING_INSTRUCTIONS} ${PULL_REQUEST_CHECK_INSTRUCTION}`
        : PULL_REQUEST_LINKING_INSTRUCTIONS,
      PULL_REQUEST_WRITING_INSTRUCTION,
    ].join('\n\n'),
    has('link') && 'Use link without task_id to attach works, automations, PRs, and project files to the current session. Markdown plan files use kind=file and path. Relative paths use the calling session’s working directory.',
    has('watch_pull_request') && PULL_REQUEST_WATCH_INSTRUCTIONS,
  ].filter(Boolean).join('\n\n')
}
