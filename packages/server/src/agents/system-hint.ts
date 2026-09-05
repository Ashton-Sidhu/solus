export interface SystemPromptOptions {
  /** App-wide instructions the user configured in Solus. */
  extraInstructions?: string
  /** User-configured instructions scoped to the model currently running. */
  modelInstructions?: string
}

function userInstructionBlock(title: string, body: string): string | null {
  const trimmed = body.trim()
  if (!trimmed) return null
  return `${title}\n${trimmed}`
}

/** Build only the user-controlled instruction append. Provider behavior stays
 *  with the provider, and capability guidance stays with its tool or skill. */
export function buildSystemPrompt(opts: SystemPromptOptions): string {
  const parts: string[] = []
  const extra = userInstructionBlock('User extra instructions:', opts.extraInstructions ?? '')
  if (extra) parts.push(extra)
  const modelExtra = userInstructionBlock('Model-specific instructions:', opts.modelInstructions ?? '')
  if (modelExtra) parts.push(modelExtra)
  return parts.join('\n\n')
}
