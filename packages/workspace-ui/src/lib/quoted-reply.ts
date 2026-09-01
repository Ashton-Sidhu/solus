export function quotedReplyDraft(text: string): string {
  const snippet = text.trim()
  if (!snippet) return ''
  return `${snippet
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')}\n\n`
}
