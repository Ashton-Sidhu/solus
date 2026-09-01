import type { RunLogLine, RunStatus } from '../../shared/types'

/** Human label for a run: its configured name, else the raw command. */
export function runLabel(run: RunStatus): string {
  return run.name ?? run.command ?? 'run command'
}

/** Wrap log lines in a markdown code fence for sending to chat. */
export function fence(lines: RunLogLine[]): string {
  return ['```', ...lines.map((l) => l.text), '```'].join('\n')
}
