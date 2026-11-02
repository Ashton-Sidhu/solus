// The host tables of `solus.db` as `sqlite-core` tables, re-exported by
// `./sqlite.ts` (drizzle-kit's SQLite entry). drizzle-kit reads named exports
// only, so each table is listed by hand; a new host table is added here and in
// `../host-tables.ts`.
import * as host from '../host-tables'

export const sessions = host.sessions.sqlite
export const session_messages = host.sessionMessages.sqlite
export const session_files = host.sessionFiles.sqlite
export const session_keys = host.sessionKeys.sqlite
export const session_lineage_members = host.sessionLineageMembers.sqlite
export const session_thread_aliases = host.sessionThreadAliases.sqlite
export const pinned_sessions = host.pinnedSessions.sqlite
export const runs = host.runs.sqlite
export const run_queue = host.runQueue.sqlite
export const run_exchanges = host.runExchanges.sqlite
export const async_questions = host.asyncQuestions.sqlite
export const outbox_ops = host.outboxOps.sqlite
export const delivery_queue = host.deliveryQueue.sqlite
export const transcript_mirror_rows = host.transcriptMirrorRows.sqlite
export const activity_mirror_rows = host.activityMirrorRows.sqlite
export const kv = host.kv.sqlite
export const projects = host.projects.sqlite
export const recent_projects = host.recentProjects.sqlite
export const saved_prompts = host.savedPrompts.sqlite
export const automations = host.automations.sqlite
export const automation_runs = host.automationRuns.sqlite
export const browser_profiles = host.browserProfiles.sqlite
export const browser_profile_defaults = host.browserProfileDefaults.sqlite
export const integration = host.integration.sqlite
export const integration_connection = host.integrationConnection.sqlite
export const notification_pr_observations = host.notificationPrObservations.sqlite
export const saved_metrics_queries = host.savedMetricsQueries.sqlite
export const turn_flags = host.turnFlags.sqlite
