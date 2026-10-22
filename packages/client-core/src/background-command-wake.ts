// The wake a provider's background command sends when it finishes after the
// agent's turn ended, read back from the wake's own text (`codexBackgroundCommandWake`
// in `execution/agents/codex/codex-utils.ts`). A history row keeps no origin,
// so the text is what every client has, live and after a reload alike. The
// first line is the wake's signature; `tests/unit/background-command-wake.test.ts`
// runs the host's template through this reader so the two cannot drift.

export interface BackgroundCommandWake {
  command: string
  /** Null when the provider reported no exit code. */
  exitCode: number | null
  /** The command's output tail, or null when it printed nothing. */
  output: string | null
  /** The command failed: a non-zero exit needs the agent. */
  attention: boolean
}

const HEADER_LINE = /^A background command finished after your turn ended(?: \(exit (-?\d+)\))?: (.*)$/
const OUTPUT_HEAD = '\n\nOutput (last part):\n'

/** The wake this prompt is, or null for any other prompt. Reads only the first
 *  line before it commits, so a transcript of ordinary prompts pays nothing. */
export function backgroundCommandWake(text: string): BackgroundCommandWake | null {
  const trimmed = text.trimStart()
  const lineEnd = trimmed.indexOf('\n')
  const header = HEADER_LINE.exec(lineEnd === -1 ? trimmed : trimmed.slice(0, lineEnd))
  if (!header) return null
  const exitCode = header[1] === undefined ? null : Number(header[1])
  const outputAt = trimmed.indexOf(OUTPUT_HEAD)
  const output = outputAt === -1 ? null : trimmed.slice(outputAt + OUTPUT_HEAD.length)
  return {
    command: header[2]!,
    exitCode,
    output: output && output.length > 0 ? output : null,
    attention: exitCode !== null && exitCode !== 0,
  }
}

/** The wake in a few words, for the row that folds its output away:
 *  "exit 1", or "finished" when the provider reported no code. */
export function backgroundCommandWakeSummary(wake: BackgroundCommandWake): string {
  return wake.exitCode === null ? 'finished' : `exit ${wake.exitCode}`
}
