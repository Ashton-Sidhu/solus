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

Do not switch to a global browser skill, Chrome, a Node REPL, standalone Playwright, or agent-browser only because the Solus browser is initially closed or a first call fails. Use another browser system only when the Solus browser tools are absent, the user explicitly requests another browser, or browser_open returns an explicit unsupported or unavailable error. Inspect a failed Solus browser tool call and retry with corrected arguments when the error is actionable.`

/** Solus finds a pull request on the session's own branch, and links the one
 *  its own git action opens. It cannot see one the agent opens or works on
 *  any other way (gh, another branch, a stack layer, an existing pull request). */
const PULL_REQUEST_LINKING_INSTRUCTIONS = `## Pull request linking

Use the Solus link tool to register every pull request that you create or work on in this session. Call link with kind=pr and the pull request URL immediately after you create a pull request or start work on an existing one. For a stack, link every layer, not only the current branch. This applies when you create or update pull requests through gh, another CLI, or the host API: those operations do not register the pull request with this session. Linking an already-linked pull request is safe. Do not link pull requests that you mention only as background. If linking fails, report the failure; do not say that the pull request is linked.`

const PULL_REQUEST_CHECK_INSTRUCTION = 'Before you finish pull request work, call list_session_pull_requests and link each pull request from your work that is missing.'

const ORCHESTRATION_INSTRUCTIONS = `## Solus orchestration

Use a native subagent for brief same-provider work when it supports the chosen model. Use start_session for another provider or model, a durable Solus conversation, or nested async work. File related work as task=attempt on the current task. Start an unrelated conversation only when the user asks for it.

Give each worker the full brief, constraints, and expected result; it does not see this conversation. Choose its workspace before starting: worktree_base_branch creates an isolated worktree, otherwise cwd selects the checkout. A shell command in the prompt does not change the session's workspace binding.

Solus tool definitions can load through the harness's tool search. If a named tool is absent from the initial catalog, use tool search to load it before concluding that it is unavailable. Do not start duplicate work to work around a tool discovery failure.

Prefer report=true and wait_seconds=0. End your turn while the worker runs; its report wakes you. A wait timeout does not cancel work. Keep the returned session and exchange IDs. An ended provider turn with open child work is not a final result. Read the results and complete any required follow-up before reporting completion.

Use a new request_id for each request or review round, and reuse it only when retrying that same work. Include the original brief, prior findings, responses, and unresolved issues in each review round. Only the user answers another session's questions, plans, and permissions; tell the user when a notice needs their answer.`

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
 *  `browser_status` for Browser, `link` for Tasks, `start_session` for Sessions. */
export function runtimeInstructions(runtime: AgentRuntime, tools: readonly AgentTool[]): string {
  const runtimeInfo = `<runtime_info>In case you are asked: you are running in Solus through the ${runtime.harness} harness as ${singleLine(runtime.model)} with ${singleLine(runtime.reasoningEffort)} reasoning effort. Do not mention this otherwise.

You can embed images and videos in your response with Markdown and absolute file paths. Solus shows them inline.</runtime_info>`
  const has = (name: string) => tools.some((tool) => tool.name === name)
  return [
    runtimeInfo,
    isChat(runtime.workingDirectory) && CHAT_INSTRUCTIONS,
    has('start_session') && [
      ORCHESTRATION_INSTRUCTIONS,
      has('list_agent_targets') && 'Before choosing a worker provider or model, call list_agent_targets for the current catalog. A native subagent tool may support fewer models than the host.',
      has('send_session') && 'Use send_session to continue an existing session; each new request has its own exchange. Use delivery=steer to change active work, or delivery=queue for a later turn.',
      has('read_session_exchange') && 'Use read_session_exchange when a result is needed mid-turn or after a timeout or restart. Do not poll in a loop or start a watcher to wait for a worker report.',
    ].filter(Boolean).join('\n\n'),
    has('browser_status') && SOLUS_BROWSER_TOOL_INSTRUCTIONS,
    has('link') && (has('list_session_pull_requests')
      ? `${PULL_REQUEST_LINKING_INSTRUCTIONS} ${PULL_REQUEST_CHECK_INSTRUCTION}`
      : PULL_REQUEST_LINKING_INSTRUCTIONS),
  ].filter(Boolean).join('\n\n')
}
