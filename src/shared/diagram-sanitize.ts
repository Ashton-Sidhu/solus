// NOTE: sanitizeNodeHtml is currently a passthrough — full DOMPurify
// sanitization is still pending (install dompurify + @types/dompurify first).
// Node `html` is rendered via {@html}, so treat it as trusted until this lands.
export function sanitizeNodeHtml(html: string): string {
  return html
}

export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:'
  } catch {
    return false
  }
}
