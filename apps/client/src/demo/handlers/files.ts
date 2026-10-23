import { arg } from './args'
import type { AssetFindUrlRequest } from '@solus/contracts/rpc'
import type { FilePreviewRequest, WriteFileRequest } from '@solus/contracts/types'
import type { DemoServer } from '../fixtures/types'
import type { DemoStore } from '../store'

/** Each fixture project's favicon, so the sidebar shows real project icons
 *  rather than one folder glyph for every project. */
const PROJECT_ICONS: Record<string, string> = {
  '/home/demo/api-gateway':
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#4f46e5"/><path d="M8 12h14m-4-4 4 4-4 4M24 20H10m4-4-4 4 4 4" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  '/home/demo/billing-service':
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#d97706"/><rect x="6.5" y="9.5" width="19" height="13" rx="2.5" fill="none" stroke="#fff" stroke-width="2.5"/><path d="M6.5 14h19" stroke="#fff" stroke-width="2.5"/><path d="M10 19h4" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>',
  '/home/demo/web-dashboard':
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0284c7"/><path d="M10 23v-6M16 23V9M22 23v-9" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>',
  '/home/demo/ios-app':
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#059669"/><rect x="10" y="6" width="12" height="20" rx="3" fill="none" stroke="#fff" stroke-width="2.5"/><circle cx="16" cy="22" r="1.5" fill="#fff"/></svg>',
  '/home/demo/infra':
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#ea580c"/><path d="m16 7 10 5-10 5-10-5z" fill="#fff"/><path d="m6 17 10 5 10-5M6 21.5l10 5 10-5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/></svg>',
  '/home/demo/marketing-site':
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#db2777"/><circle cx="16" cy="16" r="8.5" fill="none" stroke="#fff" stroke-width="2.5"/><path d="M7.5 16h17M16 7.5c-3.5 4.5-3.5 12.5 0 17M16 7.5c3.5 4.5 3.5 12.5 0 17" fill="none" stroke="#fff" stroke-width="2"/></svg>',
}

export function registerFilesHandlers(backend: DemoServer, store: DemoStore): void {
  backend.register('assetFindUrl', (args) => {
    const [path] = arg<AssetFindUrlRequest>(args, 1).paths
    const root = Object.keys(PROJECT_ICONS).find((projectRoot) => path?.startsWith(`${projectRoot}/`))
    if (!root) return null
    return {
      path,
      relativeUrl: `data:image/svg+xml,${encodeURIComponent(PROJECT_ICONS[root])}`,
      expiresAt: Date.now() + 24 * 60 * 60_000,
    }
  })
  backend.register('listProjectFiles', () => store.listProjectFiles())
  backend.register('readProjectFile', (args) => {
    const request = arg<FilePreviewRequest>(args, 1)
    return store.readProjectFile(request.path)
  })
  backend.register('writeFile', (args) => {
    const request = arg<WriteFileRequest>(args, 1)
    // The demo's fixture tree is text-only, so an image export has nowhere real
    // to land — saying so beats writing base64 into a fake file.
    if (request.encoding === 'base64') {
      return { ok: false as const, path: request.path, error: 'Saving images is not available in the demo.' }
    }
    return store.writeFile(request.path, request.contents)
  })
  // The demo has no filesystem behind its fixture tree, so the files pane's
  // create/rename/delete says so rather than appearing to work.
  backend.register('mutateProjectFile', () => ({
    ok: false as const,
    error: 'Changing files is not available in the demo.',
  }))
  // No host builds an index behind the fixture tree; a click on an identifier
  // answers "nothing here" rather than a null the card cannot read.
  backend.register('codeIntelStatus', () => ({ root: null, languages: [] }))
  backend.register('codeIntelSymbolAt', () => ({
    ok: true as const,
    symbol: null,
    language: null,
    freshness: 'fresh' as const,
  }))
  backend.register('codeIntelReindex', () => ({
    ok: false as const,
    error: 'Code intelligence is not available in the demo.',
  }))
  // The demo answers no symbols, so nothing can ask for an MDN summary; the
  // handler exists so a stray call reads as unavailable rather than hanging.
  backend.register('codeIntelDocs', () => ({
    ok: false as const,
    error: 'MDN reference is not available in the demo.',
  }))
}
