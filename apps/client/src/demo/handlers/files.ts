import { arg } from './args'
import type { FilePreviewRequest, WriteFileRequest } from '@solus/contracts/types'
import type { DemoServer } from '../fixtures/types'
import type { DemoStore } from '../store'

export function registerFilesHandlers(backend: DemoServer, store: DemoStore): void {
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
