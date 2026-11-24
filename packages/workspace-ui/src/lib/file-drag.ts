import { localApi } from '@solus/client-core/local-api'
import { MAX_ATTACHMENT_UPLOAD_BYTES } from '@solus/contracts/rpc'
import { hostPathBaseName } from '@solus/contracts/host-path'
import { serverConnections } from '@solus/client-core/server-connections'
import type { IpcContext } from '@solus/contracts/types'
import { toasts } from './toasts'

interface FileDragSource {
  serverId: string
  path: string
  name?: string
  ctx?: IpcContext
}

async function prepare(source: FileDragSource, signal: AbortSignal): Promise<string | null> {
  const { serverId, path, ctx } = source
  const name = source.name || hostPathBaseName(path) || 'attachment'
  const { relativeUrl } = await serverConnections.apiFor(serverId).assetCreateUrl(ctx, { path, name, download: true })
  const origin = serverConnections.httpOriginFor(serverId)
  if (!origin) throw new Error('The file host is disconnected.')
  const url = new URL(relativeUrl, origin)
  if (url.origin !== origin || !url.pathname.startsWith('/api/assets/')) {
    throw new Error('The host returned an invalid file download URL.')
  }
  const response = await fetch(url, { signal })
  if (!response.ok || !response.body) throw new Error('The host could not send this file.')
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
        throw new Error('This file exceeds the 10 MB drag limit.')
      }
      chunks.push(new Uint8Array(value))
    }
  } finally {
    reader.releaseLock()
  }
  signal.throwIfAborted()
  return await localApi.prepareFileDrag?.(name, await new Blob(chunks).arrayBuffer()) ?? null
}

/** Stage with the same signed host URL as Download. The native shell receives
 * bytes only and can only drag files staged by this window. */
export function fileDrag(node: HTMLElement, sourceFor: (target: HTMLElement) => FileDragSource | null) {
  const platform = localApi.getPlatform?.()
  if ((platform !== 'darwin' && platform !== 'win32') || !localApi.startFileDrag) return
  const lifetime = new AbortController()
  let gesture: AbortController | undefined

  const options = { signal: lifetime.signal }
  node.addEventListener('pointerover', (event) => {
    if (!(event.target instanceof HTMLElement)) return
    const target = event.target.closest<HTMLElement>('[data-file-ref]') ?? node
    target.draggable = !!sourceFor(target)
  }, options)
  node.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !(event.target instanceof Element)) return
    const target = event.target.closest<HTMLElement>('[data-file-ref]') ?? node
    const source = sourceFor(target)
    if (!source) return
    target.draggable = true
    gesture?.abort()
    gesture = new AbortController()
    const current = gesture
    for (const end of ['pointerup', 'pointercancel', 'blur']) {
      window.addEventListener(end, () => current.abort(), { once: true, signal: current.signal })
    }
  }, options)
  node.addEventListener('dragstart', (event) => {
    if (!(event.target instanceof HTMLElement)) return
    const source = sourceFor(event.target)
    if (!source) return
    event.preventDefault()
    event.stopImmediatePropagation()
    const current = gesture
    if (!current || current.signal.aborted) return
    void prepare(source, current.signal).then(async (token) => {
      if (lifetime.signal.aborted || current.signal.aborted) return
      if (!token || !(await localApi.startFileDrag?.(token))) throw new Error('The file is unavailable on this computer.')
    }).catch((error) => {
      if (!lifetime.signal.aborted && !current.signal.aborted) {
        toasts.error(error instanceof Error ? error.message : 'Could not drag the file.')
      }
    })
  }, { ...options, capture: true })

  return { destroy() {
    lifetime.abort()
    gesture?.abort()
  } }
}
