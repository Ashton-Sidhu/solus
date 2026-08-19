import type { FilePreviewRequest, WriteFileRequest } from '../../../../src/shared/types'
import type { DemoServer } from '../fixtures/types'
import type { DemoStore } from '../store'

export function registerFilesHandlers(backend: DemoServer, store: DemoStore): void {
  backend.register('listProjectFiles', () => store.listProjectFiles())
  backend.register('readProjectFile', (args) => {
    const request = args[1] as FilePreviewRequest
    return store.readProjectFile(request.path)
  })
  backend.register('writeFile', (args) => {
    const request = args[1] as WriteFileRequest
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
}
