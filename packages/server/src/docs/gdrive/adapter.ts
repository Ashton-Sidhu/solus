import type {
  DocDestination,
  DocDiagramAsset,
  DocDraft,
  DocPatch,
  DocProviderStatus,
  DocRef,
  DocScope,
  DocSummary,
  NormalizedDoc,
} from '@solus/contracts/docs'
import { hasGoogleDriveReadScope } from '@solus/contracts/google-auth'
import { getAccessToken, grantedGoogleScopes, isGoogleOAuthConfigured } from '../../google/oauth'
import {
  docUrlFor,
  exportDocMarkdown,
  fileMetadata,
  listDocs,
  listFolders,
  updateDocContent,
  uploadHtmlAsDoc,
  uploadMarkdownAsDoc,
  type DriveFile,
  type DriveListOptions,
} from '../../google/drive'
import { buildGoogleDocHtml } from '../../google/document-html'
import { DocProviderUnavailableError, DocVersionConflictError, type DocProviderAdapter } from '../types'

/**
 * Google Docs through Drive.
 *
 * A `DocScope` here is a folder id, or `root` for My Drive; the same string is
 * the `externalKey` persisted in a link, because a Drive doc has no other
 * durable container.
 *
 * Reading a doc Solus did not create needs the `drive.readonly` scope. A grant
 * approved before that scope shipped still publishes, so it stays connected and
 * reports the narrower reach as a `limitation` — an empty search result must
 * never be the only evidence of it.
 */
const DRIVE_READ_LIMITATION =
  'This Google connection can only see documents Solus created. Reconnect Google Drive in Settings → Providers to search and read the rest of the Drive.'

export class GoogleDriveDocAdapter implements DocProviderAdapter {
  readonly id = 'gdrive' as const

  async status(): Promise<DocProviderStatus> {
    if (!isGoogleOAuthConfigured()) {
      // No OAuth client in this build, so there is no sign-in to offer.
      return {
        provider: this.id,
        connected: false,
        reason: 'Google Drive is unavailable in this build of Solus.',
        connectable: false,
      }
    }
    const token = await getAccessToken()
    if (!token) {
      return {
        provider: this.id,
        connected: false,
        reason: 'Google Drive is not connected.',
        connectable: true,
      }
    }
    const status: DocProviderStatus = { provider: this.id, connected: true }
    if (!hasGoogleDriveReadScope(grantedGoogleScopes() ?? undefined)) {
      status.limitation = DRIVE_READ_LIMITATION
    }
    return status
  }

  async destinations(): Promise<DocDestination[]> {
    const token = await this.token()
    const folders = await listFolders(token)
    return [
      { provider: this.id, scope: 'root', label: 'My Drive' },
      ...folders.map((folder) => ({ provider: this.id, scope: folder.id, label: folder.name })),
    ]
  }

  async search(scope: DocScope | undefined, query: string): Promise<DocSummary[]> {
    const token = await this.token()
    const options: DriveListOptions = { query }
    if (scope) options.folderId = scope
    const files = await listDocs(token, options)
    return files.map((file) => {
      const summary: DocSummary = {
        ref: this.ref(file, scope ?? 'root'),
        title: file.name,
        kind: 'document',
      }
      if (file.modifiedTime) summary.updatedAt = file.modifiedTime
      return summary
    })
  }

  async read(ref: DocRef): Promise<NormalizedDoc> {
    const token = await this.token()
    const [file, markdown] = await Promise.all([
      fileMetadata(token, ref.externalId),
      exportDocMarkdown(token, ref.externalId),
    ])
    return this.normalize(file, ref.externalKey, markdown)
  }

  async create(scope: DocScope, doc: DocDraft): Promise<NormalizedDoc> {
    const token = await this.token()
    const assets = validatedDiagramAssets(doc.diagramAssets)
    const created = assets.length
      ? await uploadHtmlAsDoc(token, doc.title, await buildGoogleDocHtml(doc.markdown, assets), scope)
      : await uploadMarkdownAsDoc(token, doc.title, doc.markdown, scope)
    const file = await fileMetadata(token, created.docId)
    return this.normalize(file, scope, doc.markdown)
  }

  async update(ref: DocRef, patch: DocPatch): Promise<NormalizedDoc> {
    const token = await this.token()
    // Drive v3 takes no write precondition, so the guard is an explicit read
    // first. The race window is small and the alternative — writing blind —
    // would silently destroy an upstream edit.
    if (patch.expectedVersion !== undefined) {
      const current = await fileMetadata(token, ref.externalId)
      if (current.version !== undefined && current.version !== patch.expectedVersion) {
        throw new DocVersionConflictError(current.version, current.modifiedTime)
      }
    }
    const assets = validatedDiagramAssets(patch.diagramAssets)
    const content = assets.length ? await buildGoogleDocHtml(patch.markdown, assets) : patch.markdown
    const updated = await updateDocContent(
      token,
      ref.externalId,
      content,
      assets.length ? 'text/html' : 'text/markdown',
      patch.title,
    )
    return this.normalize(updated, ref.externalKey, patch.markdown)
  }

  resolveUrl(url: string): DocRef | null {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return null
    }
    if (parsed.hostname !== 'docs.google.com' && parsed.hostname !== 'drive.google.com') return null
    const fileId = parsed.pathname.match(/\/d\/([A-Za-z0-9_-]+)/)?.[1] ?? parsed.searchParams.get('id')
    if (!fileId) return null
    // The containing folder is unknown from a URL alone; `root` is the scope a
    // later publish would use, and reads never consult it.
    return { provider: this.id, externalKey: 'root', externalId: fileId, url: docUrlFor(fileId) }
  }

  private ref(file: DriveFile, scope: DocScope): DocRef {
    return {
      provider: this.id,
      externalKey: scope,
      externalId: file.id,
      url: file.webViewLink ?? docUrlFor(file.id),
    }
  }

  private normalize(file: DriveFile, scope: DocScope, markdown: string): NormalizedDoc {
    const doc: NormalizedDoc = {
      ref: this.ref(file, scope),
      title: file.name,
      markdown,
    }
    if (file.version !== undefined) doc.version = file.version
    if (file.modifiedTime) doc.updatedAt = file.modifiedTime
    return doc
  }

  private async token(): Promise<string> {
    if (!isGoogleOAuthConfigured()) {
      throw new DocProviderUnavailableError(this.id, 'Google Drive is unavailable in this build of Solus.')
    }
    const token = await getAccessToken()
    if (!token) {
      throw new DocProviderUnavailableError(this.id, 'Google Drive is not connected. Connect it in Settings → Providers.')
    }
    return token
  }
}

function validatedDiagramAssets(assets: DocDiagramAsset[] | undefined): DocDiagramAsset[] {
  if (!assets?.length) return []
  if (assets.length > 20) throw new Error('A document can include at most 20 unique diagrams.')
  let totalBytes = 0
  for (const asset of assets) {
    const bytes = Buffer.from(asset.base64, 'base64')
    totalBytes += bytes.byteLength
    if (totalBytes > 12 * 1024 * 1024) throw new Error('The embedded diagrams are too large to publish together.')
    if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
      throw new Error(`Diagram “${asset.title}” is not a valid PNG image.`)
    }
  }
  return assets
}
