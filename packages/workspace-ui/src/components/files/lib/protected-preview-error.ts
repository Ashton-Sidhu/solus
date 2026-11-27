export const PROTECTED_PREVIEW_MAX_BYTES = 50 * 1024 * 1024

export type ProtectedPreviewKind =
  | 'zip'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'odt'
  | 'ods'
  | 'odp'
  | 'epub'

export type ProtectedPreviewErrorCode =
  | 'password-required'
  | 'password-incorrect'
  | 'encryption-unsupported'
  | 'decryption-limit'
  | 'epub-drm'
  | 'file-too-large'
  | 'archive-too-many-entries'
  | 'archive-path-too-long'
  | 'archive-expanded-too-large'
  | 'archive-invalid'
  | 'document-invalid'

const MESSAGES = {
  'password-required': 'This file requires a password.',
  'password-incorrect': 'Incorrect password. Try again.',
  'encryption-unsupported': 'This file uses encryption that the preview cannot open.',
  'decryption-limit': 'This document requires too much work to decrypt in the preview.',
  'epub-drm': 'This ebook requires a reader that supports its DRM.',
  'file-too-large': 'Preview limited to files under 50 MB.',
  'archive-too-many-entries': 'This archive contains more than 2,048 entries.',
  'archive-path-too-long': 'An archive path is too long to preview.',
  'archive-expanded-too-large':
    'The expanded archive exceeds the preview size or compression ratio limit.',
  'archive-invalid': 'This is not a readable ZIP archive.',
  'document-invalid': 'This file is damaged or is not a valid document.',
} satisfies Record<ProtectedPreviewErrorCode, string>

export class ProtectedPreviewError extends Error {
  readonly code: ProtectedPreviewErrorCode

  constructor(code: ProtectedPreviewErrorCode) {
    super(MESSAGES[code])
    this.name = 'ProtectedPreviewError'
    this.code = code
  }
}

export function isProtectedPreviewError(cause: unknown): cause is ProtectedPreviewError {
  return cause instanceof ProtectedPreviewError
}

const PREVIEW_KIND_BY_EXTENSION = new Map<string, ProtectedPreviewKind>([
  ['zip', 'zip'],
  ['jar', 'zip'],
  ['docx', 'docx'],
  ['xlsx', 'xlsx'],
  ['pptx', 'pptx'],
  ['odt', 'odt'],
  ['ods', 'ods'],
  ['odp', 'odp'],
  ['epub', 'epub'],
])

export function protectedPreviewKind(path: string): ProtectedPreviewKind | null {
  const leaf = path.split(/[\\/]/).at(-1) ?? ''
  const dot = leaf.lastIndexOf('.')
  if (dot <= 0) return null
  return PREVIEW_KIND_BY_EXTENSION.get(leaf.slice(dot + 1).toLowerCase()) ?? null
}

export async function readBoundedResponse(
  response: Response,
  maxBytes = PROTECTED_PREVIEW_MAX_BYTES,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const contentLength = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ProtectedPreviewError('file-too-large')
  }
  if (!response.body) {
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > maxBytes) throw new ProtectedPreviewError('file-too-large')
    return buffer
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      signal?.throwIfAborted()
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new ProtectedPreviewError('file-too-large')
      chunks.push(value)
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }
  const combined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return combined.buffer
}
