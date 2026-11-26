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

/**
 * A secret that `request_secret` saves with `delivery: "file"` stays in its private
 * file for 24 hours, so the agent's commands can read it during the task.
 */
export const SECRET_FILE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Whether a tool call renders a page in the conversation and saves it as an
 * artifact. Claude names the tool `mcp__solus__…`; Codex passes it bare.
 */
export function isArtifactRenderTool(name: string | undefined): boolean {
  return !!name && name.endsWith('render_artifact')
}

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
    'read_automations',
    'manage_automations',
  ] },
  { id: 'apps', label: 'Apps', tools: [
    'save_app',
    'deploy_app',
    'publish_app',
    'unpublish_app',
    'export_app',
    'preview_app',
    'checkout_app',
    'list_apps',
    'inspect_app',
    'retry_app_run',
    'set_app_signal_action',
  ] },
  { id: 'webhooks', label: 'Webhooks', tools: [
    'read_webhooks',
    'manage_webhooks',
  ] },
  { id: 'hosts', label: 'Hosts', tools: [
    'list_hosts',
    'add_host',
    'create_host',
    'start_host',
    'stop_host',
    'restart_host',
    'update_host',
    'check_host',
    'share_host',
    'unshare_host',
    'remove_host',
    'delete_host',
  ] },
  { id: 'connections', label: 'Connections', tools: [
    'connection_status',
    'connect_integration',
    'add_mcp_server',
  ] },
  { id: 'organization', label: 'Organization', tools: [
    'list_organization_members',
    'read_organization_policy',
    'update_organization_policy',
  ] },
  { id: 'sharing', label: 'Sharing', tools: [
    'read_sharing',
    'share',
    'create_share_link',
    'remove_share_link',
  ] },
  { id: 'insights', label: 'Insights', tools: [
    'query_insights',
  ] },
  { id: 'config', label: 'Configuration', tools: [
    'read_config',
    'update_config',
    'read_theme',
    'update_theme',
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
    'start_sessions',
    'send_session',
    'stop_session',
    'fork_session',
    'organize_session',
    'queue_session',
    'list_sessions',
    'watch_pull_request',
    'list_thread_pull_requests',
    'pull_request_read',
    'pull_request_list',
    'pull_request_create',
    'pull_request_update',
    'pull_request_respond',
    'pull_request_review',
    'pull_request_merge',
    'ci_logs',
    'ci_rerun',
    'pull_request_guide_read',
    'pull_request_guide_write',
    'unlink',
    'list_links',
    'link',
    'background_wait',
    'checkout_status',
    'move_checkout',
    'attach_folder',
  ] },
  { id: 'projects', label: 'Projects', tools: [
    'create_project',
    'clone_project',
    'list_projects',
    'read_project',
    'update_project',
    'delete_project',
    'list_codebases',
    'read_codebase',
    'update_codebase',
    'delete_codebase',
  ] },
  { id: 'tasks', label: 'Issues', tools: [
    'list_issues',
    'read_issue',
    'update_issue_status',
    'create_issue',
    'comment_issue',
  ] },
] as const

export type ConfigurableSolusToolName = (typeof SOLUS_TOOL_GROUPS)[number]['tools'][number]
export type SolusToolPreferences = Partial<Record<ConfigurableSolusToolName, boolean>>

export const CONFIGURABLE_SOLUS_TOOL_NAMES = SOLUS_TOOL_GROUPS.flatMap((group) => [...group.tools])

/**
 * Tools that became one action of a grouped tool: the reads need no approval,
 * the changes do. A switch that a person or a policy set on an old name applies
 * to its new tool, so a tool that was off stays off.
 */
const RENAMED_SOLUS_TOOLS: Readonly<Record<string, ConfigurableSolusToolName>> = {
  list_automations: 'read_automations',
  read_automation: 'read_automations',
  list_automation_runs: 'read_automations',
  create_automation: 'manage_automations',
  update_automation: 'manage_automations',
  delete_automation: 'manage_automations',
  run_automation: 'manage_automations',
  list_webhooks: 'read_webhooks',
  read_webhook_delivery: 'read_webhooks',
  dry_run_webhook: 'read_webhooks',
  create_webhook: 'manage_webhooks',
  update_webhook: 'manage_webhooks',
  delete_webhook: 'manage_webhooks',
  rotate_webhook: 'manage_webhooks',
}

/** The switches with each old tool name moved to its new tool. Off wins: one old tool that was off turns its whole new tool off. */
export function withRenamedSolusTools(switches: Readonly<Record<string, boolean>>): Record<string, boolean> {
  const next: Record<string, boolean> = {}
  for (const [name, enabled] of Object.entries(switches)) {
    if (!RENAMED_SOLUS_TOOLS[name]) next[name] = enabled
  }
  for (const [name, enabled] of Object.entries(switches)) {
    const renamed = RENAMED_SOLUS_TOOLS[name]
    if (renamed) next[renamed] = (next[renamed] ?? true) && enabled
  }
  return next
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
