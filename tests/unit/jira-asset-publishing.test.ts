import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { z } from 'zod'
import type { ExternalTicketRef } from '@solus/contracts/task-types'
import type { AtlassianRequest } from '@solus/server/atlassian/api'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

/**
 * Jira takes a file as an issue attachment, not as a URL in the body. These
 * tests pin the one multipart write the adapter makes, and the two rules that
 * make it safe to retry: a publication is recorded per issue, and the durable
 * Markdown keeps its `asset://` reference while only the sent body changes.
 */

const CLOUD_ID = 'cloud-1'
let requests: AtlassianRequest[] = []
let attachmentCounter = 0

mock.module('@solus/server/atlassian/api', () => ({
  IGNORED_RESPONSE: z.unknown(),
  atlassianRequest: <Schema extends z.ZodType>(
    request: AtlassianRequest,
    schema: Schema,
  ): Promise<z.infer<Schema>> => {
    requests.push(request)
    if (!request.path.endsWith('/attachments')) throw new Error(`unexpected request ${request.path}`)
    const form = request.body
    if (!(form instanceof FormData)) throw new Error('attachments must be multipart')
    const file = form.get('file')
    if (!(file instanceof Blob)) throw new Error('the attachment file is missing')
    attachmentCounter += 1
    return Promise.resolve(schema.parse([{
      id: String(attachmentCounter),
      filename: form.get('file') instanceof File ? (form.get('file') as File).name : 'file',
      content: `https://acme.atlassian.net/rest/api/3/attachment/content/${attachmentCounter}`,
    }]))
  },
  connectedSiteUrl: () => Promise.resolve('https://acme.atlassian.net'),
  connectedSite: () => Promise.resolve({ cloudId: CLOUD_ID, siteUrl: 'https://acme.atlassian.net' }),
}))

function digest(seed: string): string {
  return seed.repeat(64).slice(0, 64)
}

const PNG_ID = `${digest('a')}.png`
const HTML_ID = `${digest('b')}.html`

function ticket(issueKey: string): ExternalTicketRef {
  return { provider: 'jira', externalKey: `${CLOUD_ID}/ACME`, externalId: issueKey, url: '' }
}

type AdapterModule = typeof import('@solus/server/tasks/adapters/jira')
type DbModule = typeof import('@solus/server/db')

let adapter: InstanceType<AdapterModule['JiraTaskSyncAdapter']>
let db: DbModule
let dataDir: string
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-jira-assets-'))
  process.env.SOLUS_DATA_DIR = dataDir
  mkdirSync(join(dataDir, 'assets'), { recursive: true })
  writeFileSync(join(dataDir, 'assets', PNG_ID), Buffer.from('fake png bytes'))
  writeFileSync(join(dataDir, 'assets', HTML_ID), Buffer.from('<!doctype html><title>Report</title>'))
  adapter = new (await import('@solus/server/tasks/adapters/jira')).JiraTaskSyncAdapter()
  db = await import('@solus/server/db')
})

beforeEach(() => {
  requests = []
  attachmentCounter = 0
  db.getDb().exec('DELETE FROM asset_publications')
})

afterEach(() => {
  db.closeDb()
})

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

describe('publishing a body to Jira', () => {
  test('nothing a body can reference is refused', () => {
    // WHY: Jira attaches any file, so an artifact's .html travels with its
    // still here — the one provider where "rendered upstream" can carry the
    // interactive copy too.
    expect(adapter.unpublishableAssets(`[report](asset://${HTML_ID}) ![still](asset://${PNG_ID})`)).toEqual([])
  })

  test('attaches each asset to the issue and links it from the sent body', async () => {
    const body = `![Latency report](asset://${PNG_ID})\n\nSource: [report.html](asset://${HTML_ID})`
    const published = await adapter.publishAssets(ticket('ACME-7'), body)

    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(request.method).toBe('POST')
      expect(request.path).toBe('/rest/api/3/issue/ACME-7/attachments')
      expect(request.body).toBeInstanceOf(FormData)
    }
    // ADF cannot embed an attachment by URL, so even the image becomes a link
    // — the attachment panel shows the picture; the link names it.
    expect(published).toBe(
      '[Latency report](https://acme.atlassian.net/rest/api/3/attachment/content/1)\n\n'
      + 'Source: [report.html](https://acme.atlassian.net/rest/api/3/attachment/content/2)',
    )
    // Durable Markdown is the caller's, not ours: publishing derives a body.
    expect(body).toContain(`asset://${PNG_ID}`)
  })

  test('a retry on the same issue attaches nothing twice', async () => {
    // WHY: the sync engine retries a failed comment post. Without the record,
    // every retry would add a duplicate attachment to the issue.
    const body = `![still](asset://${PNG_ID})`
    const first = await adapter.publishAssets(ticket('ACME-7'), body)
    const second = await adapter.publishAssets(ticket('ACME-7'), body)

    expect(requests).toHaveLength(1)
    expect(second).toBe(first)
  })

  test('the same still on another issue is attached there too', async () => {
    // WHY: an attachment belongs to one issue. A URL recorded for ACME-7 is
    // not a file on ACME-8, so the publication is keyed by issue, not by site.
    const body = `![still](asset://${PNG_ID})`
    await adapter.publishAssets(ticket('ACME-7'), body)
    const other = await adapter.publishAssets(ticket('ACME-8'), body)

    expect(requests).toHaveLength(2)
    expect(other).toContain('/attachment/content/2')
  })

  test('a body with no local reference makes no request', async () => {
    const body = 'Plain text, and https://example.com/image.png'
    expect(await adapter.publishAssets(ticket('ACME-7'), body)).toBe(body)
    expect(requests).toHaveLength(0)
  })
})
