import { describe, expect, test } from 'bun:test'
import type { SessionHistoryPage } from '@solus/contracts/session-history'
import { TranscriptModel, type TranscriptItem } from '../../apps/mobile/src/features/conversation/lib/transcript-model'
import { deriveThreadFeedPresentation, type FeedSourceEntry } from '../../apps/mobile/src/features/threads/thread-feed-presentation'
import { artifactDocument, artifactThemeCss, isArtifactDocumentUrl, readArtifactHeight } from '../../apps/mobile/src/features/threads/artifact-frame'

type ArtifactItem = Extract<TranscriptItem, { kind: 'artifact' }>

const PAGE = '<!doctype html><title>Revenue</title><body><p>Chart</p></body>'
const artifacts = (model: TranscriptModel) =>
  model.order.map((id) => model.items.get(id)).filter((item): item is ArtifactItem => item?.kind === 'artifact')

const toolRow = (toolName: string, toolId: string, input: object) => ({ role: 'tool', toolName, toolId, toolInput: JSON.stringify(input), toolStatus: 'completed', content: '', timestamp: 1 })
const resultRow = (toolId: string, extra: object = {}) => ({ role: 'tool_result', toolResultForId: toolId, content: 'ok', status: 'ok', timestamp: 2, ...extra })
const history = (messages: object[]): SessionHistoryPage => ({ messages, before: null } as SessionHistoryPage)

describe('native artifacts: transcript', () => {
  test('a render_artifact call in history shows its page after the call, named by its saved work', () => {
    const model = TranscriptModel.fromHistory('s1', history([
      { role: 'user', content: 'chart it', messageId: 'u1', timestamp: 0 },
      toolRow('mcp__solus__render_artifact', 'call-1', { html: PAGE }),
      resultRow('call-1', { artifactWorkRef: { workId: 'w1', title: 'Q3 revenue', contentVersion: 1 } }),
    ]))
    expect(model.order.map((id) => model.items.get(id)?.kind)).toEqual(['user', 'tool', 'artifact'])
    expect(artifacts(model)[0]).toMatchObject({ html: PAGE, title: 'Q3 revenue', workId: 'w1' })
  })

  test('history shows no page for a failed call, a preview, or an image', () => {
    const model = TranscriptModel.fromHistory('s1', history([
      toolRow('render_artifact', 'failed', { html: PAGE }),
      resultRow('failed', { status: 'error' }),
      toolRow('render_artifact', 'preview', { html: PAGE, preview: true }),
      resultRow('preview'),
      toolRow('render_artifact', 'image', { kind: 'image', path: '/tmp/a.png' }),
      resultRow('image'),
    ]))
    expect(artifacts(model)).toEqual([])
  })

  test('an update_work call is a new revision only when its receipt names an artifact work', () => {
    const model = TranscriptModel.fromHistory('s1', history([
      toolRow('mcp__solus__update_work', 'doc', { work_id: 'd1', content: '# Notes' }),
      resultRow('doc', { workUpdateSucceeded: true }),
      toolRow('mcp__solus__update_work', 'art', { work_id: 'w1', content: PAGE }),
      resultRow('art', { artifactWorkRef: { workId: 'w1', title: 'Q3 revenue', contentVersion: 2 } }),
    ]))
    expect(artifacts(model).map((item) => item.workId)).toEqual(['w1'])
  })

  test('live, a created artifact appends its page and each saved update adds one revision', () => {
    const model = new TranscriptModel('s1')
    model.apply({ type: 'artifact_created', toolId: 'call-1', kind: 'html', html: PAGE, workId: 'w1', title: '' })
    const update = { type: 'work_updated', workId: 'w1', title: '', docType: 'doc', content: `${PAGE}<p>v2</p>`, updatedAt: '2026-10-13T10:00:00Z' } as const
    // A cloud-owned save reports `doc`; the earlier render says it is an artifact.
    model.apply(update)
    // The same save delivered twice adds no second card.
    model.apply(update)
    // A document the conversation never rendered stays a document.
    model.apply({ ...update, workId: 'd1' })
    expect(artifacts(model).map((item) => [item.workId, item.title])).toEqual([['w1', 'Revenue'], ['w1', 'Revenue']])
  })
})

describe('native artifacts: feed', () => {
  const entries: FeedSourceEntry[] = [
    { id: 'u1', kind: 'user' },
    { id: 'a1', kind: 'assistant' },
    { id: 't1', kind: 'tool' },
    { id: 'r1', kind: 'artifact', workId: 'w1' },
    { id: 't2', kind: 'tool' },
    { id: 'r2', kind: 'artifact', workId: 'w1' },
    { id: 'a2', kind: 'assistant' },
  ]

  test('a finished turn keeps its pages out of the fold, and only the latest revision is open', () => {
    const rows = deriveThreadFeedPresentation({ entries, turnActive: false, working: false, expandedTurnIds: new Set(), expandedWorkGroupIds: new Set() })
    expect(rows.filter((row) => row.type === 'artifact')).toEqual([
      { type: 'artifact', id: 'r1', superseded: true },
      { type: 'artifact', id: 'r2', superseded: false },
    ])
  })
})

describe('native artifacts: frame', () => {
  test('the page carries the shared sandbox theme on the feed canvas', () => {
    const css = artifactThemeCss('dark', '#1e1d1b', false)
    expect(css).toContain('--background:#1e1d1b')
    expect(css).toContain('color-scheme:dark')
    // Only the full-screen page scrolls.
    expect(css).not.toContain('html{overflow:auto}')
    expect(artifactThemeCss('dark', '#1e1d1b', true)).toContain('html{overflow:auto}')
    const document = artifactDocument(PAGE, css)
    expect(document).toContain('Content-Security-Policy')
    expect(document).toContain('ReactNativeWebView')
    // A page laid out wider than the phone reports heights in larger pixels than its frame, and the frame grows without end.
    expect(document).toContain('width=device-width')
    expect(document.endsWith(PAGE)).toBe(true)
  })

  test('only a positive height report sizes the frame', () => {
    expect(readArtifactHeight(JSON.stringify({ type: 'solus-artifact-height', h: 311.2 }))).toBe(312)
    expect(readArtifactHeight(JSON.stringify({ type: 'solus-artifact-height', h: 0 }))).toBeNull()
    expect(readArtifactHeight(JSON.stringify({ type: 'other', h: 300 }))).toBeNull()
    expect(readArtifactHeight('not json')).toBeNull()
  })

  test('a link never replaces the page', () => {
    expect(isArtifactDocumentUrl('about:blank')).toBe(true)
    expect(isArtifactDocumentUrl('https://example.com')).toBe(false)
  })
})
