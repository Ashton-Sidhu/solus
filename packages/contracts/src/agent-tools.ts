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
/** User-controlled tools, grouped by their function in Settings. */
export const SOLUS_TOOL_GROUPS = [
  { id: 'intelligence', label: 'Intelligence', tools: [
    'ask_jev',
  ] },
  { id: 'works', label: 'Works', tools: [
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
  ] },
  { id: 'docs', label: 'External documents', tools: [
    'search_external_doc',
    'read_external_doc',
    'read_external_doc_comments',
    'write_external_doc_comment',
    'create_external_doc',
    'update_external_doc',
    'import_external_doc',
  ] },
  { id: 'automations', label: 'Automations', tools: [
    'create_automation',
    'list_automations',
    'read_automation',
    'update_automation',
    'delete_automation',
    'run_automation',
    'list_automation_runs',
    'read_automation_run',
  ] },
  { id: 'connections', label: 'Connections', tools: [
    'connection_status',
  ] },
  { id: 'insights', label: 'Insights', tools: [
    'query_insights',
  ] },
  { id: 'config', label: 'Configuration', tools: [
    'read_config',
    'update_config',
  ] },
  { id: 'browser', label: 'Browser', tools: [
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
  ] },
  { id: 'sessions', label: 'Sessions', tools: [
    'list_agent_targets',
    'search_sessions',
    'read_session',
    'read_task_sessions',
    'start_session',
    'send_session',
    'stop_session',
    'claude_subagent',
    'codex_subagent',
  ] },
  { id: 'tasks', label: 'Tasks', tools: [
    'list_tasks',
    'read_task',
    'update_task_status',
    'create_task',
    'comment_task',
    'link_task',
  ] },
] as const

export type ConfigurableSolusToolName = (typeof SOLUS_TOOL_GROUPS)[number]['tools'][number]
export type SolusToolPreferences = Partial<Record<ConfigurableSolusToolName, boolean>>

export const CONFIGURABLE_SOLUS_TOOL_NAMES = SOLUS_TOOL_GROUPS.flatMap((group) => [...group.tools])

/** Tools a host may still have a saved preference for after they were removed.
 *  The preference is dropped on read; any other unknown name is still refused. */
export const RETIRED_SOLUS_TOOL_NAMES: readonly string[] = [
  'wait_for_session', 'answer_session', 'review_plan',
  'create_session', 'prompt_session', 'find_sessions',
]

export function withoutRetiredSolusTools(preferences: Record<string, boolean>): Record<string, boolean> {
  return Object.fromEntries(Object.entries(preferences).filter(([name]) => !RETIRED_SOLUS_TOOL_NAMES.includes(name)))
}

export function isSolusToolEnabled(name: string, preferences: SolusToolPreferences): boolean {
  return !Object.entries(preferences).some(([toolName, enabled]) => toolName === name && !enabled)
}

export const SOLUS_AGENT_TOOL_NAMES = [
  ...CONFIGURABLE_SOLUS_TOOL_NAMES,
  // Internal review output is required by its purpose-built run.
  'submit_review_guide',
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
