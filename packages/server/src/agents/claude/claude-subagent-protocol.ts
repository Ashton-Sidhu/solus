export interface ClaudeToolResultTextBlock {
  text?: string
}

export type ClaudeToolResultContent = string | readonly ClaudeToolResultTextBlock[] | undefined

export function claudeToolResultText(content: ClaudeToolResultContent): string {
  if (!content) return ''
  if (!Array.isArray(content)) return content
  return content
    .map((block) =>
      block.text ?? '',
    )
    .join('\n')
}

export function parseClaudeTaskNotification(
  content: string,
): { toolUseId: string; result: string } | null {
  if (!content.includes('<task-notification>')) return null
  const toolUseId = content.match(/<tool-use-id>([^<]+)<\/tool-use-id>/)?.[1]?.trim()
  const result = content.match(/<result>([\s\S]*?)<\/result>/)?.[1]?.trim()
  return toolUseId && result ? { toolUseId, result } : null
}
