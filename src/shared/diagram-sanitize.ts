import DOMPurify from 'dompurify'

/**
 * Sanitize agent-authored node `html` before it hits {@html}. The default
 * DOMPurify profile strips scripts, event-handler attributes and javascript:
 * URLs while keeping the data-* attributes DiagramNode's click delegation
 * reads (ALLOW_DATA_ATTR is on by default).
 */
export function sanitizeNodeHtml(html: string): string {
  // No DOM available (this shared module can also load in the main process for
  // isSafeUrl) — refuse rather than return unsanitized markup.
  if (!DOMPurify.isSupported) return ''
  return DOMPurify.sanitize(html)
}

export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:'
  } catch {
    return false
  }
}
