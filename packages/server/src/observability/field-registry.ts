import type {
  MetricsFieldDescriptor,
  MetricsFieldGroup,
  MetricsFieldType,
  MetricsSchema,
  MetricsViewDescriptor,
} from '@solus/contracts/observability-types'
import { SPAN_KINDS, type SpanKind } from './registries'
import {
  effectiveDurationSql,
  effectiveStartedAtSql,
  providerWaitSql,
  thinkingTimeSql,
} from './trace-timing'

// ─── Field registry ───
//
// The registered catalog of queryable fields per kind, and the generator of the
// two-table query model (docs/plans/observability.md, WP4.7): `turns` — one row
// per turn with its per-kind child time pre-summed — and `events` — one row per
// non-internal child span, where a kind is a filter, not a table. `internal.*`
// kinds get the same treatment as `internal_events`. Single source of truth
// for the generated views, the NL agent's schema
// prompt, and editor completion/hover docs. An attr can be promoted to a real
// column later without breaking a saved query, because the view column name is
// the stable contract.

export type FieldStorage =
  /** A promoted `spans` column, selected as-is (aliased when name differs). */
  | { source: 'column'; column: string }
  /** A JSON path inside the `attrs` object. */
  | { source: 'attr'; path: string }
  /** A JSON path inside the JSON-string `attrs.input` (tool input is stored as
   *  one size-capped string, which truncation can leave malformed — the
   *  generated SQL guards with json_valid so queries never abort). */
  | { source: 'inputAttr'; path: string }
  /** A raw SQL expression over `spans` columns; `spans` names the outer row. */
  | { source: 'expression'; sql: string }

export interface RegisteredField {
  /** The SQL column name in the view (snake_case). */
  name: string
  type: MetricsFieldType
  description: string
  /** The query role the schema panel groups the column under. */
  group: MetricsFieldGroup
  storage: FieldStorage
}

const column = (name: string, columnName: string, type: MetricsFieldType, description: string): RegisteredField =>
  ({ name, type, description, group: 'detail', storage: { source: 'column', column: columnName } })
const attr = (name: string, path: string, type: MetricsFieldType, description: string): RegisteredField =>
  ({ name, type, description, group: 'detail', storage: { source: 'attr', path } })
const inputAttr = (name: string, path: string, type: MetricsFieldType, description: string): RegisteredField =>
  ({ name, type, description, group: 'detail', storage: { source: 'inputAttr', path } })

/** Assigns one query role to a block of fields, so the declaration reads as the
 *  grouping the schema panel renders. */
const withGroup = (group: MetricsFieldGroup, fields: RegisteredField[]): RegisteredField[] =>
  fields.map((field) => ({ ...field, group }))

/** The summed duration of one child kind across the turn's trace — the
 *  pre-computed correlation that lets "tool time by model" run as a plain
 *  GROUP BY on `turns`. A duration total: overlapping children (parallel
 *  tools) sum past wall-clock by design; the waterfall's interval union stays
 *  the wall-clock truth. */
/** A fact recorded on the trace's root turn, surfaced on every event in the
 *  trace — the turns⇄events join pre-done in the other direction, so slicing
 *  events by their turn's automation, task, or branch needs no join either. */
const rootAttr = (name: string, path: string, type: MetricsFieldType, description: string): RegisteredField => ({
  name,
  type,
  description,
  group: 'dimension',
  storage: {
    source: 'expression',
    sql: `(SELECT json_extract(root.attrs, '$.${path}') FROM spans AS root`
      + ` WHERE root.span_id = spans.trace_id)`,
  },
})

const childTime = (name: string, kind: SpanKind, description: string): RegisteredField => ({
  name,
  type: 'duration',
  description,
  group: 'child_time',
  storage: {
    source: 'expression',
    sql: `(SELECT SUM(child.duration_ms) FROM spans AS child`
      + ` WHERE child.trace_id = spans.trace_id AND child.kind = '${kind}')`,
  },
})

const durationExpression = (
  name: string,
  sql: string,
  description: string,
  group: MetricsFieldGroup,
): RegisteredField => ({
  name,
  type: 'duration',
  description,
  group,
  storage: { source: 'expression', sql },
})

/** Dimensions and timing shared by every kind's view. */
export const BASE_FIELDS: RegisteredField[] = [
  ...withGroup('identity', [
    column('span_id', 'span_id', 'string', 'Unique span id; a turn root shares it with trace_id'),
    column('parent_span_id', 'parent_span_id', 'string', 'Parent span id inside the trace, null on roots'),
    column('trace_id', 'trace_id', 'string', 'Trace id shared by one turn (or internal operation) and its children'),
    column('session_id', 'session_id', 'string', 'Solus session the span belongs to, null for internal spans'),
  ]),
  ...withGroup('dimension', [
    column('provider', 'provider', 'string', "Agent backend: 'claude' or 'codex'"),
    column('model', 'model', 'string', 'Executed model (rerouting latched), e.g. claude-fable-5'),
    column('project_root', 'project_root', 'string', 'Absolute project directory the work ran in'),
    column('origin', 'origin', 'string', "Prompt source: 'typed', 'queued', 'automation', 'agent', or 'dispatch'"),
    column('service', 'service', 'string', "Owning subsystem, e.g. 'solus.sessions' or 'solus.text-generation'"),
  ]),
  ...withGroup('timing', [
    column('started_at', 'started_at', 'number', 'Start time, epoch milliseconds'),
    column('ended_at', 'ended_at', 'number', 'End time, epoch milliseconds; null while open'),
    column('duration_ms', 'duration_ms', 'duration', 'Observed duration in milliseconds'),
    column('status', 'status', 'string', "'ok', 'error', 'interrupted', or 'unknown'"),
  ]),
]

/** The `spans` fact table's own columns. Every generated view is a `kind`
 *  slice of it. It is deliberately absent from `registeredViewNames()`: a
 *  query reading it declares no result grain, and the client falls back to a
 *  plain grid. */
const BASE_TABLE_DESCRIPTION = 'The fact table every view reads from; one row per span, of any kind'

const BASE_TABLE_FIELDS: RegisteredField[] = [
  ...withGroup('dimension', [
    column('kind', 'kind', 'string', 'Span kind, and therefore which view the row belongs to'),
    column('name', 'name', 'string', 'Kind-specific name: the tool, the RPC method, the operation'),
  ]),
  ...BASE_FIELDS,
  column('attrs', 'attrs', 'string', 'JSON object of the kind-specific fields; read with json_extract'),
]

/** The facts a query author needs before any column list makes sense. Served
 *  with the schema so the console's schema panel, the editor's hover docs, and
 *  the NL agent's prompt all state one relationship model. */
export const SCHEMA_RELATIONSHIPS: string[] = [
  'Two tables answer nearly every question: turns is one row per user-to-agent turn, and '
  + 'events is one row per operation observed inside or beside one — filter events by kind '
  + 'instead of looking for a table per kind.',
  'turns already carries provider_wait_ms and each per-kind child time sum (tool_time_ms, thinking_time_ms, '
  + 'streaming_time_ms, setup_time_ms, permission_wait_ms, question_wait_ms, compaction_time_ms, queue_wait_ms, '
  + 'rate_limit_wait_ms, settlement_time_ms), so "… by model, project, or session" needs no join.',
  'An event inside a turn shares its trace_id (a turn root has span_id = trace_id); join '
  + 'events to turns on trace_id only when an event breakdown needs a turn column that is '
  + 'not already summed on turns.',
  'spans is the raw fact table beneath every view. A query that joins two views or reads '
  + 'spans directly returns a plain result grid: no single grain is declared, so the rows '
  + 'cannot drill into a turn or a span.',
]

interface KindRegistration {
  /** One clause, glossing the kind value where `kind` columns are documented. */
  description: string
  fields: RegisteredField[]
}

const TOOL_NAME_FIELD = column('tool', 'name', 'string', 'Tool name, e.g. Bash, Read, Edit')

/** Per-kind field catalog. The QuerySpec compiler resolves registry field names
 *  through it when a spec pins a kind; the turn entry is also the `turns` view.
 *  Kinds no longer get a view each — `viewNameForKind` maps them onto the
 *  two-table model. */
export const KIND_REGISTRY: Record<SpanKind, KindRegistration> = {
  [SPAN_KINDS.turn]: {
    description: 'one user-to-agent turn: the trace root, from dispatch to settlement',
    fields: [
      ...withGroup('measure', [
        attr('cost_usd', 'costUsd', 'number', 'Turn cost in USD: provider-reported for Claude, computed from static token prices for Codex'),
        attr('input_tokens', 'inputTokens', 'number', 'Input tokens for the turn'),
        attr('output_tokens', 'outputTokens', 'number', 'Output tokens for the turn'),
        attr('cache_read_tokens', 'cacheReadTokens', 'number', 'Prompt-cache read tokens for the turn'),
        attr('cache_write_tokens', 'cacheCreationTokens', 'number', 'Prompt-cache write tokens for the turn'),
        attr('tool_call_count', 'toolCallCount', 'number', 'Tool calls observed during the turn'),
        attr('permission_denial_count', 'permissionDenialCount', 'number', 'Permission requests the user denied during the turn'),
        attr('inter_turn_idle_ms', 'interTurnIdleMs', 'duration', 'Idle time between the previous settlement and this dispatch in the same session'),
        attr('time_to_first_activity_ms', 'timeToFirstActivityMs', 'duration', 'Turn start to first observed top-level thinking, text, tool, or assistant-message event'),
        attr('time_to_first_text_ms', 'timeToFirstTextMs', 'duration', 'Turn start to first visible top-level text chunk; may follow tool calls'),
        attr('time_to_first_provider_event_ms', 'timeToFirstProviderEventMs', 'duration', 'Turn start to the first normalized provider event received by Solus'),
        attr('time_to_last_provider_event_ms', 'timeToLastProviderEventMs', 'duration', 'Turn start to the last normalized provider event received by Solus'),
        attr('time_to_provider_complete_ms', 'timeToProviderCompleteMs', 'duration', 'Turn start to the provider task-complete event received by Solus'),
      ]),
      childTime('tool_time_ms', SPAN_KINDS.toolCall, 'Total tool-call time inside the turn, pre-summed so no join is needed'),
      durationExpression(
        'thinking_time_ms',
        thinkingTimeSql('spans'),
        'Total Thinking time, including the uncovered lead-in before each reported thinking span',
        'child_time',
      ),
      childTime('streaming_time_ms', SPAN_KINDS.responseStream, 'Total response-streaming time inside the turn'),
      childTime('setup_time_ms', SPAN_KINDS.setup, 'Pre-agent setup time inside the turn: git state, worktree, task prep'),
      childTime('permission_wait_ms', SPAN_KINDS.permissionWait, 'Time the turn spent waiting on the user for tool permissions'),
      childTime('question_wait_ms', SPAN_KINDS.questionWait, 'Time the turn spent waiting on the user for an answer'),
      childTime('compaction_time_ms', SPAN_KINDS.contextCompaction, 'Provider-reported time spent compacting context'),
      childTime('queue_wait_ms', SPAN_KINDS.queueWait, 'Time the prompt waited in the queue before the turn started'),
      childTime('rate_limit_wait_ms', SPAN_KINDS.rateLimitWait, 'Time the turn spent waiting on provider rate limits'),
      childTime('settlement_time_ms', SPAN_KINDS.turnSettlement, 'Solus processing after provider completion before authoritative turn settlement'),
      durationExpression(
        'provider_wait_ms',
        providerWaitSql('spans'),
        'Turn wall-clock time outside recorded blocking activity after Thinking absorbs its lead-ins',
        'measure',
      ),
      ...withGroup('dimension', [
        attr('automation', 'automationName', 'string', 'Automation that dispatched the turn, by name'),
        attr('task', 'taskTitle', 'string', 'Task the turn ran under, by title'),
        attr('project', 'projectName', 'string', 'Project folder name — the tail of project_root'),
        attr('branch', 'branch', 'string', 'Git branch the turn ran on, when the session had a checkout'),
        attr('hostname', 'hostname', 'string', 'Hostname of the machine that executed the turn'),
        attr('host_os', 'hostOs', 'string', "Operating system of the execution host: 'macos', 'windows', or 'linux'"),
        attr('prompt_source', 'promptSource', 'string', "How the turn was dispatched: 'typed', 'queued', 'automation', 'agent', or 'dispatch'"),
        attr('reasoning_effort', 'reasoningEffort', 'string', 'Requested reasoning effort for the turn'),
        attr('is_resume', 'isResume', 'boolean', 'True when the provider continued an existing session'),
        attr('has_thinking', 'hasThinking', 'boolean', 'True when the turn contained extended thinking'),
      ]),
      ...withGroup('identity', [
        attr('task_id', 'taskId', 'string', 'Id of the task the turn ran under — `task` is its title'),
        attr('automation_id', 'automationId', 'string', 'Id of the automation that dispatched the turn — `automation` is its name'),
      ]),
      ...withGroup('detail', [
        attr('prompt', 'prompt', 'string', 'Prompt text, capped at 4 KB (see prompt_truncated)'),
        attr('prompt_chars', 'promptChars', 'number', 'Full prompt length in characters before capping'),
        attr('prompt_truncated', 'promptTruncated', 'boolean', 'True when the stored prompt text was capped'),
        attr('system_prompt', 'systemPrompt', 'string', 'Composed system prompt the turn ran under, capped at 16 KB (see system_prompt_truncated)'),
        attr('system_prompt_chars', 'systemPromptChars', 'number', 'Full system-prompt length in characters before capping'),
        attr('system_prompt_truncated', 'systemPromptTruncated', 'boolean', 'True when the stored system prompt was capped'),
        attr('response', 'response', 'string', "The agent's answer text, capped at 8 KB (see response_truncated)"),
        attr('response_chars', 'responseChars', 'number', 'Full response length in characters before capping'),
        attr('response_truncated', 'responseTruncated', 'boolean', 'True when the stored response text was capped'),
      ]),
    ],
  },
  [SPAN_KINDS.setup]: {
    description: 'pre-agent turn setup: git state, worktree creation, task prep',
    fields: [],
  },
  [SPAN_KINDS.thinking]: {
    description: 'model thinking, including the uncovered lead-in before its provider-reported interval',
    fields: [],
  },
  [SPAN_KINDS.responseStream]: {
    description: 'answer text streaming, first to last chunk',
    fields: [],
  },
  [SPAN_KINDS.toolCall]: {
    description: 'one tool invocation',
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
    description: 'the turn waiting on the user for one tool permission',
    fields: [
      TOOL_NAME_FIELD,
      attr('decision', 'decision', 'string', "'granted' or 'denied'"),
    ],
  },
  [SPAN_KINDS.questionWait]: {
    description: 'the turn waiting on the user for an answer',
    fields: [
      attr('decision', 'decision', 'string', "'answered' when the wait completed"),
      attr('question_count', 'questionCount', 'number', 'Number of questions in the request'),
    ],
  },
  [SPAN_KINDS.contextCompaction]: {
    description: 'provider-reported context compaction',
    fields: [
      attr('trigger', 'trigger', 'string', "Provider trigger, usually 'manual' or 'auto'"),
    ],
  },
  [SPAN_KINDS.queueWait]: {
    description: 'a queued prompt waiting before its turn started',
    fields: [],
  },
  [SPAN_KINDS.rateLimitWait]: {
    description: 'waiting on a provider rate limit',
    fields: [],
  },
  [SPAN_KINDS.turnSettlement]: {
    description: 'Solus processing after provider completion before authoritative turn settlement',
    fields: [],
  },
  [SPAN_KINDS.backgroundTask]: {
    description: 'non-blocking background work; excluded from critical-path rollups',
    fields: [
      attr('blocking', 'blocking', 'boolean', 'Always false; background work never blocks the turn'),
      attr('tool_use_id', 'toolUseId', 'string', 'Tool call that launched the task, when any'),
      attr('outcome_status', 'outcomeStatus', 'string', 'Terminal status the provider reported'),
    ],
  },
  [SPAN_KINDS.agentRun]: {
    description: 'one ephemeral Solus agent run: text generation, review guides, subagents',
    fields: [
      attr('prompt_chars', 'promptChars', 'number', 'Prompt length in characters'),
      attr('reasoning_effort', 'reasoningEffort', 'string', 'Requested reasoning effort'),
      attr('tool_call_count', 'toolCallCount', 'number', 'Tool calls observed during the run'),
      attr('permission_denial_count', 'permissionDenialCount', 'number', 'Permission denials during the run'),
      attr('exit_code', 'exitCode', 'number', 'Provider process exit code, where reported'),
      attr('error', 'error', 'string', 'Failure message on error or timeout'),
      attr('timed_out', 'timedOut', 'boolean', 'True when the run hit its timeout'),
    ],
  },
  [SPAN_KINDS.internalDispatchStep]: {
    description: 'one step of the Solus work that runs before a turn reaches the provider; nests under the turn\'s setup span',
    fields: [
      attr('step', 'step', 'string', 'Dot path of the step inside dispatch, e.g. launch_run.worktree_create'),
      attr('fn', 'fn', 'string', 'Function the step times, e.g. createWorktree'),
      attr('file', 'file', 'string', 'Source file the step is measured from, e.g. control-plane.ts'),
      attr('error', 'error', 'string', 'Failure message when the step threw'),
    ],
  },
  [SPAN_KINDS.internalRpc]: {
    description: 'one RPC request handled by the Solus server',
    fields: [],
  },
  [SPAN_KINDS.internalIndexerSweep]: {
    description: 'one session-indexer sweep',
    fields: [],
  },
  [SPAN_KINDS.internalWorktreeOp]: {
    description: 'one git worktree operation',
    fields: [],
  },
}

export function isInternalKind(kind: SpanKind): boolean {
  return kind.startsWith('internal.')
}

function sessionEventKinds(): SpanKind[] {
  return Object.values(SPAN_KINDS)
    .filter((kind) => kind !== SPAN_KINDS.turn && !isInternalKind(kind))
}

function internalEventKinds(): SpanKind[] {
  return Object.values(SPAN_KINDS).filter(isInternalKind)
}

function kindColumnDescription(kinds: SpanKind[]): string {
  const glossary = kinds
    .map((kind) => `'${kind}' (${KIND_REGISTRY[kind].description})`)
    .join(', ')
  return `What happened: ${glossary}`
}

function semanticEventField(field: RegisteredField): RegisteredField {
  if (field.name === 'started_at') {
    return {
      ...field,
      description: 'Semantic start time; Thinking includes its uncovered lead-in',
      storage: { source: 'expression', sql: effectiveStartedAtSql('spans') },
    }
  }
  if (field.name === 'duration_ms') {
    return {
      ...field,
      description: 'Semantic duration; Thinking includes its uncovered lead-in',
      storage: { source: 'expression', sql: effectiveDurationSql('spans') },
    }
  }
  return field
}

/** Facts promoted onto `events` for every kind at once; null where a kind does
 *  not record them. Reading a tool fact must not require finding a tool table. */
const EVENT_FIELDS = (): RegisteredField[] => [
  ...withGroup('dimension', [
    column('kind', 'kind', 'string', kindColumnDescription(sessionEventKinds())),
    column('name', 'name', 'string', 'Kind-specific name: the tool, the operation, the wait'),
    {
      name: 'tool',
      type: 'string',
      description: 'Tool name when the event is a tool call or its permission wait, e.g. Bash, Read',
      group: 'dimension',
      storage: { source: 'expression', sql: `CASE WHEN kind IN ('${SPAN_KINDS.toolCall}', '${SPAN_KINDS.permissionWait}') THEN name END` },
    },
  ]),
  ...BASE_FIELDS.map(semanticEventField),
  rootAttr('automation', 'automationName', 'string', "Name of the automation whose turn produced the event, when any"),
  rootAttr('task', 'taskTitle', 'string', "Title of the task the event's turn ran under, when any"),
  rootAttr('branch', 'branch', 'string', "Git branch the event's turn ran on, when any"),
  rootAttr('hostname', 'hostname', 'string', "Hostname of the machine that executed the event's turn"),
  rootAttr('host_os', 'hostOs', 'string', "Operating system of the machine that executed the event's turn"),
  ...withGroup('tool', [
    inputAttr('command', 'command', 'string', 'The command field of a tool input (Bash and command tools)'),
    inputAttr('file_path', 'file_path', 'string', 'The file_path field of a tool input (file tools)'),
    attr('exit_code', 'exitCode', 'number', 'Process exit code, where the provider reports one'),
    attr('error', 'error', 'string', 'Provider error text, where reported'),
    attr('declined', 'declined', 'boolean', 'True when a tool call was declined'),
    attr('decision', 'decision', 'string', "A permission wait's outcome: 'granted' or 'denied'"),
    attr('is_subagent', 'isSubagent', 'boolean', 'True for subagent tool calls'),
    attr('parent_tool_use_id', 'parentToolUseId', 'string', 'Enclosing tool call for nested tools'),
  ]),
  column('attrs', 'attrs', 'string', 'JSON object of every remaining kind-specific field; read with json_extract'),
]

const INTERNAL_EVENT_FIELDS = (): RegisteredField[] => [
  ...withGroup('dimension', [
    column('kind', 'kind', 'string', kindColumnDescription(internalEventKinds())),
    column('name', 'name', 'string', 'The dispatch step, RPC method, sweep, or worktree operation'),
  ]),
  ...BASE_FIELDS,
  column('attrs', 'attrs', 'string', 'JSON object of the kind-specific fields; read with json_extract'),
]

export interface ViewRegistration {
  view: string
  kinds: SpanKind[]
  /** True for the separate Solus-health slice. */
  internal: boolean
  description: string
  fields: RegisteredField[]
}

/** The two-table query model, plus the internal slice. Every generated view,
 *  in the order authoring surfaces list them. */
export function viewRegistrations(): ViewRegistration[] {
  return [
    {
      view: 'turns',
      kinds: [SPAN_KINDS.turn],
      internal: false,
      // One clause, because it is read as a label above a column list. The
      // per-kind child-time sums and the "no join needed" consequence are
      // stated once, in SCHEMA_RELATIONSHIPS, which every surface also gets.
      description: 'One row per user-to-agent turn, from dispatch to settlement.',
      fields: fieldsForKind(SPAN_KINDS.turn),
    },
    {
      view: 'events',
      kinds: sessionEventKinds(),
      internal: false,
      description: 'One row per operation observed inside or beside a turn.',
      fields: EVENT_FIELDS(),
    },
    {
      view: 'internal_events',
      kinds: internalEventKinds(),
      internal: true,
      description: "Solus's own operations: RPC handling, indexer sweeps, worktree ops.",
      fields: INTERNAL_EVENT_FIELDS(),
    },
  ]
}

/** The view a kind's rows surface in — the declared grain of a query that pins
 *  that kind. */
export function viewNameForKind(kind: SpanKind): string {
  if (kind === SPAN_KINDS.turn) return 'turns'
  return isInternalKind(kind) ? 'internal_events' : 'events'
}

const VIEW_NAMES: ReadonlySet<string> = new Set(
  viewRegistrations().map((registration) => registration.view),
)

/** Every generated view name — what a declared result grain must be one of. */
export function registeredViewNames(): ReadonlySet<string> {
  return VIEW_NAMES
}

/** All fields of one kind, base columns included — what a QuerySpec pinning the
 *  kind may reference by registry name. */
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
    case 'expression':
      return field.storage.sql
  }
}

function selectClause(field: RegisteredField): string {
  const expression = fieldExpression(field)
  return expression === field.name ? expression : `${expression} AS ${field.name}`
}

export function createViewSql(view: ViewRegistration): string {
  const selects = view.fields.map(selectClause).join(',\n       ')
  const kinds = view.kinds.map((kind) => `'${kind}'`).join(', ')
  const slice = view.kinds.length === 1 ? `kind = ${kinds}` : `kind IN (${kinds})`
  return `CREATE VIEW ${view.view} AS\nSELECT ${selects}\nFROM spans WHERE ${slice}`
}

/** View names earlier registry generations created, one per kind. Dropped at
 *  boot so collapsing the schema never leaves a stale table for a user to
 *  find beside the documented ones. */
const LEGACY_VIEW_NAMES = [
  'setups', 'thinking_spans', 'response_streams', 'tool_calls', 'permission_waits',
  'queue_waits', 'rate_limit_waits', 'background_tasks', 'agent_runs',
  'internal_rpc', 'internal_indexer_sweeps', 'internal_worktree_ops',
]

/** Recreates every generated view from the registry. Runs at boot after
 *  migrations; DROP + CREATE keeps the views current when the registry changes. */
export function createMetricsViews(db: { exec(sql: string): void }): void {
  for (const name of LEGACY_VIEW_NAMES) db.exec(`DROP VIEW IF EXISTS ${name}`)
  for (const view of viewRegistrations()) {
    db.exec(`DROP VIEW IF EXISTS ${view.view}`)
    db.exec(createViewSql(view))
  }
}

function columnDescriptors(fields: RegisteredField[]): MetricsFieldDescriptor[] {
  return fields.map(({ name, type, description, group }) => ({ name, type, description, group }))
}

function viewDescriptor(view: ViewRegistration): MetricsViewDescriptor {
  return {
    view: view.view,
    kinds: view.kinds,
    internal: view.internal,
    description: view.description,
    columns: columnDescriptors(view.fields),
  }
}

/** The registry as served over `metricsSchema`. */
export function metricsSchema(): MetricsSchema {
  return {
    views: viewRegistrations().map(viewDescriptor),
    base: {
      table: 'spans',
      description: BASE_TABLE_DESCRIPTION,
      columns: columnDescriptors(BASE_TABLE_FIELDS),
    },
    relationships: SCHEMA_RELATIONSHIPS,
  }
}

function ddl(object: 'TABLE' | 'VIEW', name: string, description: string, fields: RegisteredField[]): string {
  const columns = fields
    .map((field) => `  ${field.name} ${field.type.toUpperCase()} -- ${field.description}`)
    .join('\n')
  return `-- ${description}\nCREATE ${object} ${name} (\n${columns}\n);`
}

/** Table and view DDL, per-column docs, and how they relate, formatted for the
 *  NL agent's prompt. The agent must be told the relationship model, not just
 *  the columns. */
export function schemaForPrompt(): string {
  const relationships = SCHEMA_RELATIONSHIPS.map((fact) => `-- ${fact}`).join('\n')
  const base = ddl('TABLE', 'spans', BASE_TABLE_DESCRIPTION, BASE_TABLE_FIELDS)
  const views = viewRegistrations()
    .map((view) => ddl('VIEW', view.view, view.description, view.fields))
    .join('\n\n')
  return `${relationships}\n\n${base}\n\n${views}`
}
