import type { AgentTool } from './tools/agent-tool'

/**
 * The host facts every agent gets, whatever its backend: where it runs, how
 * Solus renders what it writes, and the shared browser. This is the only copy.
 * Claude receives it through its system prompt append; Codex receives it after
 * its collaboration-mode instructions. Provider behavior stays with the
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

export interface AgentRuntime {
  harness: 'Claude Code' | 'Codex'
  model: string
  reasoningEffort: string
}

function singleLine(value: string): string {
  return value.replaceAll(/\s+/g, ' ').trim()
}

/** Each tool-group block goes only to a run that has the group's entry tool:
 *  `browser_status` for the Browser group, `link` for the Tasks group. */
export function runtimeInstructions(runtime: AgentRuntime, tools: readonly AgentTool[]): string {
  const runtimeInfo = `<runtime_info>In case you are asked: you are running in Solus through the ${runtime.harness} harness as ${singleLine(runtime.model)} with ${singleLine(runtime.reasoningEffort)} reasoning effort. Do not mention this otherwise.

You can embed images and videos in your response with Markdown and absolute file paths. Solus shows them inline.</runtime_info>`
  const has = (name: string) => tools.some((tool) => tool.name === name)
  return [
    runtimeInfo,
    has('browser_status') && SOLUS_BROWSER_TOOL_INSTRUCTIONS,
    has('link') && (has('list_session_pull_requests')
      ? `${PULL_REQUEST_LINKING_INSTRUCTIONS} ${PULL_REQUEST_CHECK_INSTRUCTION}`
      : PULL_REQUEST_LINKING_INSTRUCTIONS),
  ].filter(Boolean).join('\n\n')
}
