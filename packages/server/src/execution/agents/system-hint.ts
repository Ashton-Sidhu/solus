export interface SystemPromptOptions {
  /** App-wide instructions the user configured in Solus. */
  extraInstructions?: string
}

/** Build only the user-controlled instruction append. Host runtime facts (the
 *  harness, inline media, the shared browser) live in `runtime-instructions.ts`,
 *  provider behavior stays with the provider, and capability guidance stays with
 *  its tool or skill. */
export function buildSystemPrompt(opts: SystemPromptOptions): string {
  const trimmed = (opts.extraInstructions ?? '').trim()
  return trimmed ? `User extra instructions:\n${trimmed}` : ''
}
