import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { ExternalTicketRef } from '@solus/contracts/task-types'
import { githubClientState, installGithubClientMock, mockedRepository } from './helpers/github-client-mock.ts'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// The upload endpoint is not in the REST reference, so these tests pin the exact
// request the GitHub CLI makes (cli/cli#14180). A silent drift in the query
// string, the headers, or the failure mapping is the failure mode worth
// catching: an upload cannot be undone, so a wrong request costs real bytes.
installGithubClientMock()

interface CapturedRequest {
  url: string
  method: string
  headers: Headers
  body: Buffer
}

let requests: CapturedRequest[] = []
let respond: () => Response
const realFetch = globalThis.fetch

function digest(seed: string): string {
  return seed.repeat(64).slice(0, 64)
}

const PNG_ID = `${digest('a')}.png`
const PDF_ID = `${digest('b')}.pdf`
const MP4_ID = `${digest('c')}.mp4`
const SVG_ID = `${digest('d')}.svg`

type UploadModule = typeof import('@solus/server/providers/github/asset-upload')
type AdapterModule = typeof import('@solus/server/tasks/adapters/github')
type AssetsModule = typeof import('@solus/server/tasks/task-assets')
type DbModule = typeof import('@solus/server/db')

let upload: UploadModule
let adapter: InstanceType<AdapterModule['GitHubTaskSyncAdapter']>
let assets: AssetsModule
let db: DbModule

/** The ticket a publish is aimed at. Only the repository matters here: it is
 *  both the upload target and the key a publication is recorded against. */
function ticketIn(repositorySlug: string): ExternalTicketRef {
  return {
    provider: 'github',
    externalKey: repositorySlug,
    externalId: '42',
    url: `https://github.com/${repositorySlug}/issues/42`,
  }
}

let dataDir: string
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-github-assets-'))
  process.env.SOLUS_DATA_DIR = dataDir
  mkdirSync(join(dataDir, 'assets'), { recursive: true })
  writeFileSync(join(dataDir, 'assets', PNG_ID), Buffer.from('fake png bytes'))
  writeFileSync(join(dataDir, 'assets', PDF_ID), Buffer.from('fake pdf bytes'))
  writeFileSync(join(dataDir, 'assets', MP4_ID), Buffer.from('fake mp4 bytes'))
  writeFileSync(join(dataDir, 'assets', SVG_ID), Buffer.from('<svg />'))

  upload = await import('@solus/server/providers/github/asset-upload')
  adapter = new (await import('@solus/server/tasks/adapters/github')).GitHubTaskSyncAdapter()
  assets = await import('@solus/server/tasks/task-assets')
  db = await import('@solus/server/db')

  // SAFETY: the stub accepts the same arguments and returns the same Response
  // promise as fetch; only the network call is replaced.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const captured = new Request(String(input), init)
    requests.push({
      url: captured.url,
      method: captured.method,
      headers: captured.headers,
      body: Buffer.from(await captured.arrayBuffer()),
    })
    return respond()
  }) as typeof fetch
})

/** The reason the endpoint refused, or how the call failed to refuse properly. */
async function uploadFailureReason(assetId: string): Promise<string> {
  const target = await upload.resolveUploadTarget('solus', 'desktop')
  try {
    await upload.uploadGithubAsset(target, assetId)
    return 'unexpectedly succeeded'
  } catch (error) {
    if (error instanceof upload.GithubAssetUploadError) return error.reason
    return `unexpected error: ${String(error)}`
  }
}

beforeEach(() => {
  requests = []
  githubClientState.repository = mockedRepository('write')
  respond = () => Response.json({ url: 'https://github.com/user-attachments/assets/be9b3920' }, { status: 201 })
  upload.forgetUploadTarget('solus', 'desktop')
  upload.forgetUploadTarget('solus', 'site')
  // Publications are durable by design, so each test starts from none rather
  // than inheriting what an earlier one uploaded.
  db.getDb().exec('DELETE FROM asset_publications')
})

afterEach(() => {
  db.closeDb()
})

afterAll(() => {
  globalThis.fetch = realFetch
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

describe('github asset upload request', () => {
  test('sends the octet-stream request the endpoint requires', async () => {
    const target = await upload.resolveUploadTarget('solus', 'desktop')
    const url = await upload.uploadGithubAsset(target, PNG_ID)

    expect(url).toBe('https://github.com/user-attachments/assets/be9b3920')
    expect(requests).toHaveLength(1)
    const sent = new URL(requests[0].url)
    expect(sent.origin).toBe('https://uploads.github.com')
    expect(sent.pathname).toBe('/user-attachments/assets')
    // The stored id is the name because its extension always agrees with the
    // content type; a user-facing label does not, and a mismatch is a 422.
    expect(sent.searchParams.get('name')).toBe(PNG_ID)
    expect(sent.searchParams.get('content_type')).toBe('image/png')
    expect(sent.searchParams.get('repository_id')).toBe('1234')
    expect(requests[0].method).toBe('POST')
    expect(requests[0].headers.get('content-type')).toBe('application/octet-stream')
    expect(requests[0].headers.get('accept')).toBe('application/vnd.github+json')
    expect(requests[0].headers.get('authorization')).toBe('Bearer gho_test-token')
    expect(requests[0].body.toString()).toBe('fake png bytes')
  })

  test('reads 404 as missing write access rather than a missing repository', async () => {
    respond = () => new Response('', { status: 404 })
    expect(await uploadFailureReason(PNG_ID)).toBe('permission')
  })

  test('reports a 422 as a rejected file', async () => {
    respond = () => new Response('content_type is not included in the list', { status: 422 })
    expect(await uploadFailureReason(PNG_ID)).toBe('rejected-file')
  })

  test('treats an accepted upload with no URL as a failure', async () => {
    // Nothing can reference what was uploaded, so this cannot be a success.
    respond = () => Response.json({}, { status: 201 })
    expect(await uploadFailureReason(PNG_ID)).toBe('transport')
  })

  test('refuses read-only access before spending an irreversible upload', async () => {
    githubClientState.repository = mockedRepository('read')
    expect(await uploadFailureReason(PNG_ID)).toBe('permission')
    expect(requests).toHaveLength(0)
  })

  test('refuses a file type the endpoint does not accept, without a request', async () => {
    expect(await uploadFailureReason(PDF_ID)).toBe('unsupported-file')
    expect(requests).toHaveLength(0)
  })
})

describe('publishing a body', () => {
  test('rewrites the sent body and leaves the stored reference alone', async () => {
    const body = `Before:\n\n![Wide window](asset://${PNG_ID})\n\nAfter.`
    const published = await adapter.publishAssets(ticketIn('solus/desktop'), body)

    expect(published).toBe(
      'Before:\n\n![Wide window](https://github.com/user-attachments/assets/be9b3920)\n\nAfter.',
    )
    // Durable Markdown is the caller's, not ours: publishing derives a body.
    expect(body).toContain(`asset://${PNG_ID}`)
  })

  test('uploads one digest once however many references it has', async () => {
    const body = `![one](asset://${PNG_ID}) and again ![two](asset://${PNG_ID})`
    const published = await adapter.publishAssets(ticketIn('solus/desktop'), body)

    expect(requests).toHaveLength(1)
    expect(published).not.toContain('asset://')
  })

  test('a recorded publication makes a retry free', async () => {
    const body = `![shot](asset://${PNG_ID})`
    await adapter.publishAssets(ticketIn('solus/desktop'), body)
    expect(requests).toHaveLength(1)

    // An upload cannot be undone, so a re-post after a failed comment must reuse
    // the asset already on GitHub instead of stranding a second copy.
    const again = await adapter.publishAssets(ticketIn('solus/desktop'), body)
    expect(requests).toHaveLength(1)
    expect(again).toContain('https://github.com/user-attachments/assets/be9b3920')
  })

  test('a different repository is a different publication', async () => {
    await adapter.publishAssets(ticketIn('solus/desktop'), `![shot](asset://${PNG_ID})`)
    await adapter.publishAssets(ticketIn('solus/site'), `![shot](asset://${PNG_ID})`)
    expect(requests).toHaveLength(2)
  })

  test('renders a video as a bare URL, which is the only player syntax GitHub has', async () => {
    const published = await adapter.publishAssets(ticketIn('solus/desktop'), `Clip: [demo](asset://${MP4_ID})`)
    expect(published).toContain('\n\nhttps://github.com/user-attachments/assets/be9b3920\n\n')
    expect(published).not.toContain('![')
  })

  test('keeps an SVG a link, matching how Solus renders it locally', async () => {
    const published = await adapter.publishAssets(ticketIn('solus/desktop'), `![logo](asset://${SVG_ID})`)
    expect(published).toBe('[logo](https://github.com/user-attachments/assets/be9b3920)')
  })

  test('names the file GitHub cannot host', () => {
    const blocked = adapter.unpublishableAssets(`[brief](asset://${PDF_ID}) ![shot](asset://${PNG_ID})`)
    expect(blocked.map((reference) => reference.extension)).toEqual(['pdf'])
  })
})

describe('asset references in markdown', () => {
  test('reads an image, a link, and a bare reference', () => {
    const found = assets.assetReferencesIn(
      `![Wide](asset://${PNG_ID}) [brief](asset://${PDF_ID}) see asset://${MP4_ID} here`,
    )
    expect(found.map((reference) => reference.assetId)).toEqual([PNG_ID, PDF_ID, MP4_ID])
    expect(found[0]).toMatchObject({ label: 'Wide', isImage: true, extension: 'png' })
    expect(found[1]).toMatchObject({ label: 'brief', isImage: false })
    expect(found[2]).toMatchObject({ label: '', isImage: false })
  })

  test('ignores an id that is not a digest', () => {
    expect(assets.containsLocalAsset('asset://not-a-valid-id.png')).toBe(false)
    expect(assets.containsLocalAsset('See https://example.com/screen.png')).toBe(false)
  })

  test('leaves a reference alone when its asset was not published', () => {
    const body = `![a](asset://${PNG_ID}) ![b](asset://${SVG_ID})`
    const rewritten = assets.withPublishedAssets(
      body,
      new Map([[PNG_ID, 'https://example.test/a']]),
      (_reference, url) => `![x](${url})`,
    )
    // A partial publication must not silently drop the attachment it could not
    // send; the sender decides what to do about the remainder.
    expect(rewritten).toBe(`![x](https://example.test/a) ![b](asset://${SVG_ID})`)
  })

  test('keeps the separator in front of a bare reference', () => {
    const rewritten = assets.withPublishedAssets(
      `see asset://${MP4_ID} here`,
      new Map([[MP4_ID, 'https://example.test/clip']]),
      (_reference, url) => url,
    )
    expect(rewritten).toBe('see https://example.test/clip here')
  })
})
