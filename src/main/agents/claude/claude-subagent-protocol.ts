export function claudeToolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) =>
      block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : '',
    )
    .join('\n')
}

export function parseClaudeTaskNotification(
  content: unknown,
): { toolUseId: string; result: string } | null {
  if (typeof content !== 'string' || !content.includes('<task-notification>')) return null
  const toolUseId = content.match(/<tool-use-id>([^<]+)<\/tool-use-id>/)?.[1]?.trim()
  const result = content.match(/<result>([\s\S]*?)<\/result>/)?.[1]?.trim()
  return toolUseId && result ? { toolUseId, result } : null
}
