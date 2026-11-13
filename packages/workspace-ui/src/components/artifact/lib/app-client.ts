import type { AppClientAnswers } from '@solus/client-core/app-calls'
import { blobFromParts } from '@solus/client-core/app-files'
import { downloadBlob } from '../../work/lib/work-export'

/**
 * What this client answers itself for an app frame (docs/plans/apps.md §5).
 * `@client/save` gives the person one file as a browser download. The parent
 * document starts it: the sandbox of the frame allows no download.
 */
export const browserAppClient: AppClientAnswers = {
  async save(file) {
    let blob: Blob
    try {
      blob = blobFromParts([file.data], file.type)
    } catch {
      throw new Error('The file is not valid base64.')
    }
    downloadBlob(file.name, blob)
  },
}
