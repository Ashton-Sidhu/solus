import { describe, expect, it } from 'bun:test'
import {
  PEEK_WIDTH,
  peekBody,
  peekBox,
  peekOutline,
} from '../../src/renderer/components/workspace/lib/workspace-peek'
import type { WorkspaceItem } from '../../src/renderer/components/workspace/lib/workspace-items'

function item(over: Partial<WorkspaceItem> = {}): WorkspaceItem {
  return {
    id: 'a',
    type: 'doc',
    glyph: 'doc',
    title: 'A document',
    snippet: 'The ledger snippet.',
    createdAt: 0,
    sessionId: null,
    timestamp: 0,
    pinned: false,
    pinnedAt: 0,
    cwd: '/repo',
    projectKey: '/repo',
    projectLabel: 'repo',
    status: null,
    source: { kind: 'work', work: {} as never },
    ...over,
  }
}

describe('peekBody', () => {
  it('stands in with the ledger snippet until the document has loaded — a peek never spins', () => {
    expect(peekBody(item(), null, '')).toBe('The ledger snippet.')
  })

  it('reads the prose, not the markup: fences, bullets and link URLs never reach the card', () => {
    const content = [
      '# Title',
      '',
      '- One thing.',
      '',
      '```ts',
      'const noise = true',
      '```',
      '',
      'See [the plan](https://example.com/very/long/url).',
    ].join('\n')
    const body = peekBody(item(), content, '')
    expect(body).toBe('One thing. See the plan.')
  })

  it('stops at two sentences — the card is a reference to a page, not the page', () => {
    const content = 'First one. Second one. Third one.'
    expect(peekBody(item(), content, '')).toBe('First one. Second one.')
  })

  it('shows the passage that matched while a search is running, not the opening', () => {
    const content = `${'Opening prose. '.repeat(20)}The rollback path is manual.`
    const body = peekBody(item(), content, 'rollback')
    expect(body).toContain('rollback path is manual')
    expect(body.startsWith('…')).toBe(true)
  })
})

describe('peekOutline', () => {
  it('takes the top heading level as the document spine', () => {
    const content = ['## Context', 'text', '### Detail', '## Proposal', 'text'].join('\n')
    expect(peekOutline(item(), content).lines.map((l) => l.text)).toEqual(['Context', 'Proposal'])
  })

  it('drops a level past a lone title heading — the row above already shows it', () => {
    const content = ['# Sidebar plan', '## Context', '## Proposal'].join('\n')
    expect(peekOutline(item(), content).lines.map((l) => l.text)).toEqual(['Context', 'Proposal'])
  })

  it('falls back to a plan written as numbered steps rather than sections', () => {
    const content = ['1. Read the exports', '2. Change the store', '3. Update callers'].join('\n')
    const outline = peekOutline(item({ type: 'plan' }), content)
    expect(outline.lines.map((l) => l.n)).toEqual(['01', '02', '03'])
    expect(outline.lines[1].text).toBe('Change the store')
  })

  it('holds four lines and counts the rest, so the card never grows past its shape', () => {
    const content = ['## A', '## B', '## C', '## D', '## E', '## F'].join('\n')
    const outline = peekOutline(item(), content)
    expect(outline.lines).toHaveLength(4)
    expect(outline.more).toBe(2)
  })

  it('gives a diagram its clusters — counts are not structure and ride the meta line', () => {
    const content = JSON.stringify({
      nodes: [
        { id: 'g1', label: 'Ingest', group: true },
        { id: 'n1', label: 'Queue', parentId: 'g1' },
        { id: 'g2', label: 'Storage', group: true },
      ],
      edges: [],
    })
    const outline = peekOutline(item({ type: 'diagram' }), content)
    expect(outline.lines.map((l) => l.text)).toEqual(['Ingest', 'Storage'])
  })

  it('has no structure to show before the content lands', () => {
    expect(peekOutline(item(), null).lines).toEqual([])
  })
})

describe('peekBox', () => {
  const ledger = { top: 100, bottom: 700, left: 0, right: 1000 }

  it('hangs off the row title column, overlapping the row by 2px', () => {
    const box = peekBox({ top: 200, bottom: 244, left: 24 }, ledger, 180)
    expect(box.left).toBe(24 + 37)
    expect(box.top).toBe(242)
    expect(box.width).toBe(PEEK_WIDTH)
  })

  it('flips above a row near the foot of the ledger rather than scrolling the list', () => {
    const box = peekBox({ top: 640, bottom: 684, left: 24 }, ledger, 180)
    expect(box.top).toBe(640 + 2 - 180)
  })

  it('stays below when flipping would only clip the other edge', () => {
    const box = peekBox({ top: 120, bottom: 164, left: 24 }, ledger, 600)
    expect(box.top).toBe(162)
  })

  it('clamps inside the ledger gutter on a narrow pane', () => {
    const narrow = { top: 100, bottom: 700, left: 0, right: 500 }
    const box = peekBox({ top: 200, bottom: 244, left: 24 }, narrow, 180)
    expect(box.width).toBe(500 - 48)
    expect(box.left).toBe(24)
  })
})
