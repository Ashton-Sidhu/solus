import { z } from 'zod'
import { HOST_USE, type Permission, type ResourceActionPath, type ResourceKind } from '@solus/contracts/permissions'
import type { SolusAgentToolName } from '@solus/contracts/agent-tools'
import type { AccessResource } from '../../../admission/access'
import type { Principal } from '../../../admission/principal'
import { toolActionRefusal } from '../../../admission/workspace-tool-authority'
import type { AgentTool } from './agent-tool'

/**
 * Who may call a tool (plans/035 §5): a permission on the host, or a verb on the
 * record the call names. Each rule is the one the RPC method for the same action
 * has (`PERMISSION_OF_METHOD`, `RESOURCE_ACTION_OF_METHOD`), so a tool reaches
 * only what its person reaches from a client.
 */
export type ToolAccess =
  | { permission: Permission }
  | { action: ResourceActionPath; resource: ToolResource }

/** A tool call's arguments, after the tool's fields have parsed them. */
type ToolCallInput = Parameters<AgentTool['execute']>[0]

/** The record a call names: from its input, or the session the call runs in. Null when it names none. */
type ToolResource = (input: ToolCallInput, callerSessionId: string | undefined) => AccessResource | null

function inputId(kind: ResourceKind, field: string): ToolResource {
  const schema = z.object({ [field]: z.string().min(1) })
  return (input) => {
    const parsed = schema.safeParse(input)
    return parsed.success ? { kind, id: parsed.data[field]! } : null
  }
}

/** The session the call runs in: a tool that acts on its own session. */
const callerSession: ToolResource = (_input, callerSessionId) => callerSessionId ? { kind: 'session', id: callerSessionId } : null

/** `session_id` when the call names one, else the session the call runs in. */
const sessionIdOrCaller: ToolResource = (input, callerSessionId) => inputId('session', 'session_id')(input, callerSessionId) ?? callerSession(input, callerSessionId)

/** A comment target: a plan id is `<sessionId>__<planToolUseId>` and belongs to its session; any other id is a work. */
const commentTarget: ToolResource = (input) => {
  const target = inputId('work', 'target_id')(input, undefined)
  if (!target || !target.id.includes('__')) return target
  return { kind: 'session', id: target.id.slice(0, target.id.indexOf('__')) }
}

const hostUse = { permission: HOST_USE } as const
const gitWrite = { permission: 'host.git.write' } as const
const work = (action: ResourceActionPath): ToolAccess => ({ action, resource: inputId('work', 'work_id') })
const automation = (action: ResourceActionPath): ToolAccess => ({ action, resource: inputId('automation', 'automation_id') })
const webhook = (action: ResourceActionPath): ToolAccess => ({ action, resource: inputId('webhook', 'webhook_id') })
const ownSession = (action: ResourceActionPath): ToolAccess => ({ action, resource: callerSession })

/** Every Solus tool's rule. A tool missing here fails the type check, as an RPC method missing from the access tables does. */
export const TOOL_ACCESS = {
  // Works
  list_works: hostUse,
  read_work: work('read'),
  create_work: hostUse,
  update_work: work('edit'),
  render_artifact: hostUse,
  read_plan: { action: 'read.transcript', resource: inputId('session', 'session_id') },
  comment_document: { action: 'comment', resource: commentTarget },
  reply_comment: { action: 'comment', resource: commentTarget },
  resolve_comment: { action: 'comment', resource: commentTarget },
  publish_work: work('edit'),
  pull_work_upstream: work('edit'),
  request_work_review: work('edit'),
  // Automations: listing and creating are host-wide; a list is filtered to what its person reaches.
  create_automation: hostUse,
  list_automations: hostUse,
  read_automation: automation('read'),
  update_automation: automation('edit'),
  delete_automation: automation('edit'),
  run_automation: automation('drive'),
  list_automation_runs: automation('read'),
  // Apps
  save_app: hostUse,
  deploy_app: hostUse,
  publish_app: hostUse,
  unpublish_app: hostUse,
  export_app: hostUse,
  preview_app: hostUse,
  checkout_app: hostUse,
  list_apps: hostUse,
  inspect_app: hostUse,
  retry_app_run: hostUse,
  set_app_signal_action: hostUse,
  // Webhooks
  create_webhook: hostUse,
  update_webhook: webhook('edit'),
  delete_webhook: webhook('edit'),
  rotate_webhook: webhook('edit'),
  list_webhooks: hostUse,
  read_webhook_delivery: webhook('read'),
  dry_run_webhook: webhook('read'),
  // Connections: pairing changes how the host is reached, as the pairing RPCs do.
  list_hosts: { permission: 'host.connect' },
  add_host: { permission: 'host.local.reach' },
  remove_host: { permission: 'host.local.reach' },
  connection_status: { permission: 'host.connect' },
  connect_integration: hostUse,
  add_mcp_server: hostUse,
  query_insights: hostUse,
  // Config: a person's own settings, as personalSettingsPatch. The host sections also need host.admin (config-tools.ts).
  read_config: { permission: 'host.connect' },
  update_config: { permission: 'host.connect' },
  read_theme: { permission: 'host.connect' },
  update_theme: { permission: 'host.connect' },
  // Browser: the registry checks which person's pages a call may drive.
  browser_status: hostUse,
  browser_open: hostUse,
  browser_close: hostUse,
  browser_navigate: hostUse,
  browser_resize: hostUse,
  browser_set_appearance: hostUse,
  browser_snapshot: hostUse,
  browser_record_start: hostUse,
  browser_record_stop: hostUse,
  browser_click: hostUse,
  browser_hover: hostUse,
  browser_type: hostUse,
  browser_select: hostUse,
  browser_press: hostUse,
  browser_scroll: hostUse,
  browser_drag: hostUse,
  browser_upload: hostUse,
  browser_dialog: hostUse,
  browser_evaluate: hostUse,
  browser_wait_for: hostUse,
  // Devices beside the session's conversation, as deviceOpen and deviceClose.
  device_list: hostUse,
  device_open: ownSession('drive.devices'),
  device_screenshot: ownSession('drive.devices'),
  device_close: ownSession('drive.devices'),
  device_install: ownSession('drive.devices'),
  // Sessions
  request_secret: ownSession('drive.prompt'),
  list_agent_targets: { permission: 'host.agents.read' },
  search_sessions: { permission: 'host.sessions.read' },
  read_session: { action: 'read.transcript', resource: inputId('session', 'session_id') },
  read_session_exchange: ownSession('read.transcript'),
  start_sessions: { permission: 'host.sessions.start' },
  send_session: { action: 'drive.prompt', resource: inputId('session', 'session_id') },
  stop_session: { action: 'drive.prompt', resource: sessionIdOrCaller },
  fork_session: { action: 'drive.prompt', resource: sessionIdOrCaller },
  organize_session: { action: 'edit', resource: sessionIdOrCaller },
  queue_session: { action: 'drive.prompt', resource: sessionIdOrCaller },
  list_sessions: { permission: 'host.sessions.read' },
  watch_pull_request: ownSession('edit'),
  // Pull requests: reads as prGetDetail, writes as prMerge and the other changes.
  list_thread_pull_requests: hostUse,
  pull_request_read: hostUse,
  pull_request_list: hostUse,
  pull_request_create: gitWrite,
  pull_request_update: gitWrite,
  pull_request_respond: gitWrite,
  pull_request_review: gitWrite,
  pull_request_merge: gitWrite,
  ci_logs: hostUse,
  ci_rerun: gitWrite,
  pull_request_guide_read: hostUse,
  pull_request_guide_write: hostUse,
  // The links, checkout, folders, and waits of the session the call runs in.
  unlink: ownSession('edit'),
  list_links: ownSession('read.transcript'),
  link: ownSession('edit'),
  background_wait: ownSession('drive.prompt'),
  checkout_status: ownSession('read.transcript'),
  move_checkout: ownSession('drive.prompt'),
  attach_folder: ownSession('drive.prompt'),
  // Projects and codebases: the project and codebase RPCs.
  create_project: hostUse,
  clone_project: hostUse,
  list_projects: { permission: 'host.projects.read' },
  read_project: { permission: 'host.projects.read' },
  update_project: hostUse,
  delete_project: hostUse,
  list_codebases: hostUse,
  read_codebase: hostUse,
  update_codebase: hostUse,
  delete_codebase: hostUse,
  // Tasks: the host's copy of each task, as the task RPCs.
  list_tasks: hostUse,
  read_task: hostUse,
  update_task_status: hostUse,
  create_task: hostUse,
  comment_task: hostUse,
  // The review run's own output.
  submit_review_guide: hostUse,
} as const satisfies Record<SolusAgentToolName, ToolAccess>

const ACCESS_BY_NAME: ReadonlyMap<string, ToolAccess> = new Map(Object.entries(TOOL_ACCESS))

/** A tool's rule: the table's for a Solus tool, else its own. A tool with neither has no rule. */
export function toolAccessOf(tool: Pick<AgentTool, 'name' | 'access'>): ToolAccess | undefined {
  return ACCESS_BY_NAME.get(tool.name) ?? tool.access
}

/** Why `principal` may not make this call. Null when it may. A tool with no rule is refused. */
export async function toolAccessRefusal(tool: Pick<AgentTool, 'name' | 'access'>, input: ToolCallInput, callerSessionId: string | undefined, principal: Principal): Promise<string | null> {
  const access = toolAccessOf(tool)
  if (!access) return `${tool.name} has no access rule.`
  return 'permission' in access
    ? toolActionRefusal(tool.name, principal, access.permission, null)
    : toolActionRefusal(tool.name, principal, access.action, access.resource(input, callerSessionId))
}
