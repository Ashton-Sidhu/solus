/**
 * Every in-app tool a Solus agent can call, by name.
 *
 * The names cross a process boundary: they arrive at a client inside transcript
 * events, and the renderer decides from the name alone whether a tool call is
 * Solus's own — which card to draw, which label to print. That made the
 * renderer keep a second copy of this list, and the copy drifted: it still
 * named three goal tools that no longer exist while missing every browser,
 * external-document, comment, config, connection and insights tool, so those
 * calls rendered as raw provider names. One list, imported by the server
 * toolbox and the renderer alike, is what stops that happening again.
 *
 * Claude prefixes these with `mcp__solus__`; Codex passes them bare.
 */
export const SOLUS_AGENT_TOOL_NAMES = [
  // works
  'find_works',
  'read_work',
  'create_work',
  'update_work',
  'render_artifact',
  'read_plan',
  'comment_document',
  'reply_comment',
  'resolve_comment',
  'publish_work',
  'pull_work_upstream',
  // documents in another tool (Confluence, Google Docs)
  'search_external_doc',
  'read_external_doc',
  'create_external_doc',
  'update_external_doc',
  'import_external_doc',
  // automations
  'create_automation',
  'list_automations',
  'read_automation',
  'update_automation',
  'delete_automation',
  'run_automation',
  'list_automation_runs',
  'read_automation_run',
  // hosts and telemetry
  'connection_status',
  'query_insights',
  'read_config',
  'update_config',
  // browser
  'browser_status',
  'browser_open',
  'browser_close',
  'browser_navigate',
  'browser_resize',
  'browser_set_appearance',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_scroll',
  'browser_evaluate',
  'browser_wait_for',
  // sessions
  'list_agent_targets',
  'find_sessions',
  'read_session',
  'create_session',
  'prompt_session',
  'wait_for_session',
  'stop_session',
  'answer_session',
  'review_plan',
  // tasks
  'list_tasks',
  'read_task',
  'update_task_status',
  'create_task',
  'comment_task',
  'link_task',
  // Given to one purpose-built run rather than the toolbox, but a client still
  // has to recognize them in that run's transcript.
  'submit_review_guide',
  'claude_subagent',
  'codex_subagent',
] as const

export type SolusAgentToolName = (typeof SOLUS_AGENT_TOOL_NAMES)[number]

const BY_NAME: ReadonlyMap<string, SolusAgentToolName> = new Map(
  SOLUS_AGENT_TOOL_NAMES.map((name): [string, SolusAgentToolName] => [name, name]),
)

/** The bare Solus tool name (e.g. "create_work") when `name` is one, else null.
 *  Accepts either provider's spelling. */
export function solusAgentToolName(name: string): SolusAgentToolName | null {
  const bare = name.startsWith('mcp__solus__') ? name.slice('mcp__solus__'.length) : name
  return BY_NAME.get(bare) ?? null
}
