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
    return store.writeFile(request.path, request.contents)
  })
}
