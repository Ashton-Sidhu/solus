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
/**
 * A `secretRef` from `request_secret` works once, only in the session that asked,
 * for 15 minutes. Any tool with a `secretRef` field takes one in place of a secret.
 */
export const SECRET_REF_TTL_MS = 15 * 60 * 1000

/** User-controlled tools, grouped by their function in Settings. */
export const SOLUS_TOOL_GROUPS = [
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
    'request_work_review',
  ] },
  { id: 'automations', label: 'Automations', tools: [
    'create_automation',
    'list_automations',
    'read_automation',
    'update_automation',
    'delete_automation',
    'run_automation',
    'list_automation_runs',
  ] },
  { id: 'webhooks', label: 'Webhooks', tools: [
    'create_webhook',
    'update_webhook',
    'delete_webhook',
    'rotate_webhook',
    'list_webhooks',
    'read_webhook_delivery',
    'dry_run_webhook',
  ] },
  { id: 'connections', label: 'Connections', tools: [
    'connection_status',
    'connect_integration',
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
    'browser_record_start',
    'browser_record_stop',
    'browser_click',
    'browser_hover',
    'browser_type',
    'browser_select',
    'browser_press',
    'browser_scroll',
    'browser_drag',
    'browser_upload',
    'browser_dialog',
    'browser_evaluate',
    'browser_wait_for',
  ] },
  { id: 'devices', label: 'Devices', tools: [
    'device_list',
    'device_open',
    'device_screenshot',
    'device_close',
    'device_install',
  ] },
  { id: 'sessions', label: 'Sessions', tools: [
    'request_secret',
    'list_agent_targets',
    'search_sessions',
    'read_session',
    'read_session_exchange',
    'start_session',
    'delegate_task',
    'send_session',
    'stop_session',
    'organize_session',
    'watch_pull_request',
    'unlink',
    'list_links',
    'link',
    'background_wait',
    'worktree_status',
    'move_to_worktree',
  ] },
  { id: 'projects', label: 'Projects', tools: [
    'create_project',
    'clone_project',
  ] },
  { id: 'tasks', label: 'Tasks', tools: [
    'list_tasks',
    'read_task',
    'update_task_status',
    'create_task',
    'comment_task',
  ] },
] as const

export type ConfigurableSolusToolName = (typeof SOLUS_TOOL_GROUPS)[number]['tools'][number]
export type SolusToolPreferences = Partial<Record<ConfigurableSolusToolName, boolean>>

export const CONFIGURABLE_SOLUS_TOOL_NAMES = SOLUS_TOOL_GROUPS.flatMap((group) => [...group.tools])

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
