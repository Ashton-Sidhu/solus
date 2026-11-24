import { MAX_ATTACHMENT_UPLOAD_BYTES } from '@solus/contracts/rpc'

/** Fetch only the issuing host's signed asset. The bridge receives the resulting bytes. */
export async function downloadSignedFile(relativeUrl: string, origin: string, signal: AbortSignal): Promise<ArrayBuffer> {
  if (!origin) throw new Error('The file host is disconnected.')
  if (!/^\/api\/assets\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(relativeUrl)) {
    throw new Error('The host returned an invalid file download URL.')
  }
  const url = new URL(relativeUrl, origin)
  if (url.origin !== origin || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new Error('The host returned an invalid file download URL.')
  }
  const response = await fetch(url, { signal, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' })
  if (response.status !== 200 || !response.body) {
    void response.body?.cancel().catch(() => {})
    throw new Error('The host could not send this file.')
  }
  const tooLarge = 'This file exceeds the 10 MiB transfer limit.'
  if (Number(response.headers.get('Content-Length')) > MAX_ATTACHMENT_UPLOAD_BYTES) {
    await response.body.cancel()
    throw new Error(tooLarge)
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_ATTACHMENT_UPLOAD_BYTES) {
        await reader.cancel()
        throw new Error(tooLarge)
      }
      chunks.push(new Uint8Array(value))
    }
  } finally {
    reader.releaseLock()
  }
  signal.throwIfAborted()
  return new Blob(chunks).arrayBuffer()
}
