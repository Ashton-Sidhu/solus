import type { AgentRunResult } from './agent-runner'
import type { AgentToolResult } from './tools/agent-tool'

/** Keep failed and interrupted runs distinct from completed child answers. */
export function subagentResult(
  result: Pick<AgentRunResult, 'exitCode' | 'signal' | 'output'>,
  label: string,
  wasAborted: boolean,
): AgentToolResult {
  let error: string | undefined
  if (wasAborted || result.signal === 'SIGINT') error = `${label} subagent was interrupted.`
  else if (result.signal) error = `${label} subagent failed with signal ${result.signal}.`
  else if (result.exitCode !== null && result.exitCode !== 0) error = `${label} subagent failed with exit code ${result.exitCode}.`
  if (error) {
    return { ok: false, text: result.output ? `${error}\n\nPartial output:\n${result.output}` : error }
  }
  return { ok: true, text: result.output || `(${label} subagent returned no text.)` }
}
