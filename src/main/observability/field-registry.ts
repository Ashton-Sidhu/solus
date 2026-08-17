import type {
  MetricsFieldType,
  MetricsSchema,
  MetricsViewDescriptor,
} from '../../shared/observability-types'
import { SPAN_KINDS, type SpanKind } from './registries'

// ─── Field registry ───
//
// The registered catalog of queryable fields per kind. Single source of truth
// for the generated per-kind views, the NL agent's schema prompt, and editor
// completion/hover docs. An attr can be promoted to a real column later
// without breaking a saved query, because the view column name is the stable
// contract.

export type FieldStorage =
  /** A promoted `spans` column, selected as-is (aliased when name differs). */
  | { source: 'column'; column: string }
  /** A JSON path inside the `attrs` object. */
  | { source: 'attr'; path: string }
  /** A JSON path inside the JSON-string `attrs.input` (tool input is stored as
   *  one size-capped string, which truncation can leave malformed — the
   *  generated SQL guards with json_valid so queries never abort). */
  | { source: 'inputAttr'; path: string }

export interface RegisteredField {
  /** The SQL column name in the view (snake_case). */
  name: string
  type: MetricsFieldType
  description: string
  storage: FieldStorage
}

const column = (name: string, columnName: string, type: MetricsFieldType, description: string): RegisteredField =>
  ({ name, type, description, storage: { source: 'column', column: columnName } })
const attr = (name: string, path: string, type: MetricsFieldType, description: string): RegisteredField =>
  ({ name, type, description, storage: { source: 'attr', path } })
const inputAttr = (name: string, path: string, type: MetricsFieldType, description: string): RegisteredField =>
  ({ name, type, description, storage: { source: 'inputAttr', path } })

/** Dimensions and timing shared by every kind's view. */
export const BASE_FIELDS: RegisteredField[] = [
  column('span_id', 'span_id', 'string', 'Unique span id; a turn root shares it with trace_id'),
  column('parent_span_id', 'parent_span_id', 'string', 'Parent span id inside the trace, null on roots'),
  column('trace_id', 'trace_id', 'string', 'Trace id shared by one turn (or internal operation) and its children'),
  column('session_id', 'session_id', 'string', 'Solus session the span belongs to, null for internal spans'),
  column('provider', 'provider', 'string', "Agent backend: 'claude' or 'codex'"),
  column('model', 'model', 'string', 'Executed model (rerouting latched), e.g. claude-fable-5'),
  column('project_root', 'project_root', 'string', 'Absolute project directory the work ran in'),
  column('origin', 'origin', 'string', "Prompt source: 'typed', 'queued', 'automation', 'agent', or 'dispatch'"),
  column('service', 'service', 'string', "Owning subsystem, e.g. 'solus.sessions' or 'solus.text-generation'"),
  column('started_at', 'started_at', 'number', 'Start time, epoch milliseconds'),
  column('ended_at', 'ended_at', 'number', 'End time, epoch milliseconds; null while open'),
  column('duration_ms', 'duration_ms', 'duration', 'Observed duration in milliseconds'),
  column('status', 'status', 'string', "'ok', 'error', 'interrupted', or 'unknown'"),
]

interface KindRegistration {
  view: string
  description: string
  fields: RegisteredField[]
}

const TOOL_NAME_FIELD = column('tool', 'name', 'string', 'Tool name, e.g. Bash, Read, Edit')

export const KIND_REGISTRY: Record<SpanKind, KindRegistration> = {
  [SPAN_KINDS.turn]: {
    view: 'turns',
    description: 'One user-to-agent turn: the trace root, from dispatch to settlement',
    fields: [
      column('name', 'name', 'string', "Always 'turn'"),
      attr('prompt', 'prompt', 'string', 'Prompt text, capped at 4 KB (see prompt_truncated)'),
      attr('prompt_chars', 'promptChars', 'number', 'Full prompt length in characters before capping'),
      attr('prompt_source', 'promptSource', 'string', "How the turn was dispatched: 'typed', 'queued', 'automation', 'agent', or 'dispatch'"),
      attr('prompt_truncated', 'promptTruncated', 'boolean', 'True when the stored prompt text was capped'),
      attr('inter_turn_idle_ms', 'interTurnIdleMs', 'duration', 'Idle time between the previous settlement and this dispatch in the same session'),
      attr('reasoning_effort', 'reasoningEffort', 'string', 'Requested reasoning effort for the turn'),
      attr('task_id', 'taskId', 'string', 'Solus task the turn ran under, when any'),
      attr('automation_id', 'automationId', 'string', 'Automation that dispatched the turn, when any'),
      attr('cost_usd', 'costUsd', 'number', 'Provider-measured cost in USD; null where the provider reports none (Codex)'),
      attr('input_tokens', 'inputTokens', 'number', 'Input tokens for the turn'),
      attr('output_tokens', 'outputTokens', 'number', 'Output tokens for the turn'),
      attr('cache_read_tokens', 'cacheReadTokens', 'number', 'Prompt-cache read tokens for the turn'),
      attr('tool_call_count', 'toolCallCount', 'number', 'Tool calls observed during the turn'),
      attr('permission_denial_count', 'permissionDenialCount', 'number', 'Permission requests the user denied during the turn'),
      attr('has_thinking', 'hasThinking', 'boolean', 'True when the turn contained extended thinking'),
      attr('time_to_first_token_ms', 'timeToFirstTokenMs', 'duration', 'Dispatch to first streamed token'),
    ],
  },
  [SPAN_KINDS.setup]: {
    view: 'setups',
    description: 'Pre-agent turn setup: git state, worktree creation, task prep',
    fields: [column('name', 'name', 'string', "Always 'setup'")],
  },
  [SPAN_KINDS.toolCall]: {
    view: 'tool_calls',
    description: 'One tool invocation inside a turn; subagent tools nest via parent_tool_use_id',
    fields: [
      TOOL_NAME_FIELD,
      attr('input', 'input', 'string', 'Serialized tool input, capped at 8 KB (see input_truncated)'),
      attr('input_truncated', 'inputTruncated', 'boolean', 'True when the stored tool input was capped'),
      inputAttr('command', 'command', 'string', 'The command field of the tool input (Bash and command tools)'),
      inputAttr('file_path', 'file_path', 'string', 'The file_path field of the tool input (file tools)'),
      attr('exit_code', 'exitCode', 'number', 'Process exit code, where the provider reports one'),
      attr('outcome_status', 'outcomeStatus', 'string', 'Provider outcome status, where reported'),
      attr('error', 'error', 'string', 'Provider error text, where reported'),
      attr('declined', 'declined', 'boolean', 'True when the tool call was declined'),
      attr('provider_duration_ms', 'providerDurationMs', 'duration', 'Provider-reported duration, where available'),
      attr('is_subagent', 'isSubagent', 'boolean', 'True for subagent tool calls'),
      attr('parent_tool_use_id', 'parentToolUseId', 'string', 'Enclosing tool call for nested tools'),
    ],
  },
  [SPAN_KINDS.permissionWait]: {
    view: 'permission_waits',
    description: 'Time a turn waited on the user for one tool permission',
    fields: [
      TOOL_NAME_FIELD,
      attr('decision', 'decision', 'string', "'granted' or 'denied'"),
    ],
  },
  [SPAN_KINDS.queueWait]: {
    view: 'queue_waits',
    description: 'Time a queued prompt waited before its turn started',
    fields: [column('name', 'name', 'string', "Always 'queue_wait'")],
  },
  [SPAN_KINDS.rateLimitWait]: {
    view: 'rate_limit_waits',
    description: 'Time a turn waited on a provider rate limit',
    fields: [column('name', 'name', 'string', 'Rate limit kind reported by the provider')],
  },
  [SPAN_KINDS.backgroundTask]: {
    view: 'background_tasks',
    description: 'Non-blocking background work started by a turn; excluded from critical-path rollups',
    fields: [
      column('name', 'name', 'string', 'Background task id'),
      attr('blocking', 'blocking', 'boolean', 'Always false; background work never blocks the turn'),
      attr('tool_use_id', 'toolUseId', 'string', 'Tool call that launched the task, when any'),
      attr('outcome_status', 'outcomeStatus', 'string', 'Terminal status the provider reported'),
    ],
  },
  [SPAN_KINDS.agentRun]: {
    view: 'agent_runs',
    description: 'One ephemeral agent run (text generation, review guides, subagents) as a single coarse span',
    fields: [
      column('name', 'name', 'string', "Always 'agent_run'"),
      attr('prompt_chars', 'promptChars', 'number', 'Prompt length in characters'),
      attr('reasoning_effort', 'reasoningEffort', 'string', 'Requested reasoning effort'),
      attr('tool_call_count', 'toolCallCount', 'number', 'Tool calls observed during the run'),
      attr('permission_denial_count', 'permissionDenialCount', 'number', 'Permission denials during the run'),
      attr('exit_code', 'exitCode', 'number', 'Provider process exit code, where reported'),
      attr('error', 'error', 'string', 'Failure message on error or timeout'),
      attr('timed_out', 'timedOut', 'boolean', 'True when the run hit its timeout'),
    ],
  },
  [SPAN_KINDS.internalRpc]: {
    view: 'internal_rpc',
    description: 'One RPC request handled by the Solus server',
    fields: [column('name', 'name', 'string', 'RPC method name')],
  },
  [SPAN_KINDS.internalIndexerSweep]: {
    view: 'internal_indexer_sweeps',
    description: 'One session-indexer sweep',
    fields: [column('name', 'name', 'string', 'Sweep name')],
  },
  [SPAN_KINDS.internalWorktreeOp]: {
    view: 'internal_worktree_ops',
    description: 'One git worktree operation',
    fields: [column('name', 'name', 'string', 'Worktree operation name')],
  },
}

export function isInternalKind(kind: SpanKind): boolean {
  return kind.startsWith('internal.')
}

export function viewNameForKind(kind: SpanKind): string {
  return KIND_REGISTRY[kind].view
}

const VIEW_NAMES: ReadonlySet<string> = new Set(
  Object.values(KIND_REGISTRY).map((registration) => registration.view),
)

/** Every generated view name — what a declared result grain must be one of. */
export function registeredViewNames(): ReadonlySet<string> {
  return VIEW_NAMES
}

/** All fields of one kind's view, base columns included, in view column order. */
export function fieldsForKind(kind: SpanKind): RegisteredField[] {
  return [...BASE_FIELDS, ...KIND_REGISTRY[kind].fields]
}

/** The SELECT expression a field's storage maps to. */
export function fieldExpression(field: RegisteredField): string {
  switch (field.storage.source) {
    case 'column':
      return field.storage.column
    case 'attr':
      return `json_extract(attrs, '$.${field.storage.path}')`
    case 'inputAttr':
      return `CASE WHEN json_valid(json_extract(attrs, '$.input')) `
        + `THEN json_extract(json_extract(attrs, '$.input'), '$.${field.storage.path}') END`
  }
}

function selectClause(field: RegisteredField): string {
  const expression = fieldExpression(field)
  return expression === field.name ? expression : `${expression} AS ${field.name}`
}

export function createViewSql(kind: SpanKind): string {
  const selects = fieldsForKind(kind).map(selectClause).join(',\n       ')
  return `CREATE VIEW ${viewNameForKind(kind)} AS\nSELECT ${selects}\nFROM spans WHERE kind = '${kind}'`
}

/** Recreates every per-kind view from the registry. Runs at boot after
 *  migrations; DROP + CREATE keeps the views current when the registry changes. */
export function createMetricsViews(db: { exec(sql: string): void }): void {
  for (const kind of Object.values(SPAN_KINDS)) {
    db.exec(`DROP VIEW IF EXISTS ${viewNameForKind(kind)}`)
    db.exec(createViewSql(kind))
  }
}

function viewDescriptor(kind: SpanKind): MetricsViewDescriptor {
  return {
    view: viewNameForKind(kind),
    kind,
    internal: isInternalKind(kind),
    description: KIND_REGISTRY[kind].description,
    columns: fieldsForKind(kind).map(({ name, type, description }) => ({ name, type, description })),
  }
}

/** The registry as served over `metricsSchema`. */
export function metricsSchema(): MetricsSchema {
  return { views: Object.values(SPAN_KINDS).map(viewDescriptor) }
}

/** View DDL plus per-column docs, formatted for the NL agent's prompt. */
export function schemaForPrompt(): string {
  return Object.values(SPAN_KINDS)
    .map((kind) => {
      const registration = KIND_REGISTRY[kind]
      const columns = fieldsForKind(kind)
        .map((field) => `  ${field.name} ${field.type.toUpperCase()} -- ${field.description}`)
        .join('\n')
      return `-- ${registration.description}\nCREATE VIEW ${registration.view} (\n${columns}\n);`
    })
    .join('\n\n')
}
