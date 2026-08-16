/**
 * Analytics event contract. Event properties intentionally exclude prompt text,
 * file paths, and repository or branch names.
 */
export type Via = 'keybinding' | 'palette' | 'click'

export interface SolusEventMap {
  app_opened: {}
  conversation_started: { agent: string }
  message_sent: { agent: string; is_first_message: boolean; delivery?: 'steer' | 'queue' | 'immediate'; permission_mode?: string; attachment_count?: number; image_count?: number; plan_ref_count?: number; work_ref_count?: number; session_ref_count?: number; has_slash_command?: boolean; is_remote_host?: boolean }
  agent_switched: { from: string; to: string; via?: Via }
  settings_opened: { tab?: string; via?: Via }
  mode_toggled: { mode: 'editor' | 'pill' }
  voice_recording_started: {}
  tab_created: { via?: Via; worktree?: boolean }
  tab_selected: { via?: Via }
  tab_closed: { via?: Via }
  tab_split_opened: {}
  session_resumed: {}
  session_interrupted: {}
  permission_responded: { decision: string }
  permission_mode_set: { mode: string; via?: Via }
  worktree_mode_toggled: { enabled: boolean; via?: Via }
  worktree_switched: { via?: Via }
  branch_switched: { via?: Via }
  plan_approved: { mode: 'ask' | 'auto' }
  plan_rejected: { has_comment: boolean }
  surface_viewed: { surface: 'workspace' | 'tasks' | 'prs' | 'automations' | 'insights' | 'review' | 'pr_review' | 'plan_modal' | 'work_modal' | 'settings'; via?: Via }
  palette_command_run: { command_id: string }
  keybinding_used: { binding_id: string; scope: string; overridden: boolean }
  model_changed: { via?: Via }
  diff_feedback_submitted: {}
  route_viewed: { route: string; via?: Via }
  overlay_opened: { overlay_id: string }
  client_connected: { attempt?: number }
  client_reconnected: { attempt?: number }
  push_permission_result: { granted: boolean }
  pairing_completed: { method: 'token' | 'claim' | 'ssh' }
  pairing_failed: { method: 'token' | 'claim' | 'ssh' }
}

export interface ServerEventMap {
  run_completed: { provider: string; duration_ms: number; tool_call_count: number; saw_permission_request: boolean; permission_denial_count: number }
  run_failed: { provider: string; duration_ms: number; tool_call_count: number; saw_permission_request: boolean; permission_denial_count: number }
  run_interrupted: { provider: string; duration_ms: number; tool_call_count: number; saw_permission_request: boolean; permission_denial_count: number }
  worktree_created: {}
  automation_run_succeeded: {}
  automation_run_failed: {}
  skill_installed: {}
  pair_token_generated: {}
  model_installed: {}
  app_quit: { uptime_ms: number }
  plan_responded: { approved: boolean }
  permission_responded: { decision: string; tool_name?: string }
}

/** Remove dynamic command details such as branch names, paths, and session IDs. */
export function sanitizeCommandId(id: string): string {
  return id.split(':', 1)[0]
}
