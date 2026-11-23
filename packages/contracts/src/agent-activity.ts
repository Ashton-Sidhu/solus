import { isQuestionTool } from './question-history'

/** The things an agent does with its tools. The transcript's activity block
 *  reports them in the past tense; the state marks show the one that runs now
 *  (docs/plans/session-state-marks.md). Thinking is a kind too: it always
 *  arrives with the tools, so it folds into the same sentence rather than
 *  earning a row of its own. So is asking: the answered question folds away
 *  with the turn, and the row is what still says it was asked. */
export type AgentActivityKind = 'think' | 'ask' | 'search' | 'read' | 'edit' | 'run' | 'other'

/** The kind of each tool both providers name. Claude names its own tools;
 *  Codex names come from `codexToolNameForItem`: a command is `exec_command`,
 *  a file change is `Edit`, and a web search is `WebSearch`. A tool not listed
 *  here (MCP, Solus, sub-agent, image generation) is `other`. */
export const KIND_FOR_TOOL = {
  Read: 'read',
  read_file: 'read',
  view_image: 'read',
  NotebookRead: 'read',
  Glob: 'search',
  Grep: 'search',
  WebSearch: 'search',
  WebFetch: 'search',
  Edit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'run',
  exec_command: 'run',
} as const satisfies Record<string, AgentActivityKind>

const KIND_BY_TOOL_NAME = new Map<string, AgentActivityKind>(Object.entries(KIND_FOR_TOOL))

export function agentActivityKind(toolName: string | undefined): AgentActivityKind {
  if (!toolName) return 'other'
  // Every provider spells the question tool differently, so it is matched
  // rather than listed beside the fixed tool names above.
  if (isQuestionTool(toolName)) return 'ask'
  // A Map, so a name such as `constructor` is not a tool of the object.
  return KIND_BY_TOOL_NAME.get(toolName) ?? 'other'
}

/** What the agent does now inside a running turn. `reply` is assistant text
 *  that streams. A question is not an activity: it is the Input state. */
export type AgentActivity = Exclude<AgentActivityKind, 'ask'> | 'reply'

/** The agent activity of a top-level tool call; null for a question tool. */
export function agentActivityOfTool(toolName: string | undefined): AgentActivity | null {
  const kind = agentActivityKind(toolName)
  return kind === 'ask' ? null : kind
}
