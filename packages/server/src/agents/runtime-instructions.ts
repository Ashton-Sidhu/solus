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

export interface AgentRuntime {
  harness: 'Claude Code' | 'Codex'
  model: string
  reasoningEffort: string
}

function singleLine(value: string): string {
  return value.replaceAll(/\s+/g, ' ').trim()
}

/** The Browser tool group is on for this run. `browser_status` is its entry tool. */
export function hasBrowserTools(tools: readonly AgentTool[]): boolean {
  return tools.some((tool) => tool.name === 'browser_status')
}

export function runtimeInstructions(runtime: AgentRuntime, browserToolsAvailable: boolean): string {
  const runtimeInfo = `<runtime_info>In case you are asked: you are running in Solus through the ${runtime.harness} harness as ${singleLine(runtime.model)} with ${singleLine(runtime.reasoningEffort)} reasoning effort. Do not mention this otherwise.

You can embed images and videos in your response with Markdown and absolute file paths. Solus shows them inline.</runtime_info>`
  return browserToolsAvailable ? `${runtimeInfo}\n\n${SOLUS_BROWSER_TOOL_INSTRUCTIONS}` : runtimeInfo
}
