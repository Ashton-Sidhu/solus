import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TranscriptItem } from '../../apps/mobile/src/features/conversation/lib/transcript-model'
import { streamingMessageRowId, threadFeedItemType } from '../../apps/mobile/src/features/threads/thread-feed-item-type'
import type { ThreadFeedRow } from '../../apps/mobile/src/features/threads/thread-feed-presentation'

// The native feed's list estimates an unmeasured row from the running average
// of its type (pingdotgg/t3code#21269). These tests pin that behavior in the
// installed list, model it with fixture heights, and check that the feed's size
// classes keep short history from being estimated at the height of long replies.
// They do not prove device scrolling; that stays a device gate.

const LEGEND_LIST = join(import.meta.dir, '../../node_modules/@legendapp/list')
const ESTIMATED_ITEM_SIZE = 180 // ThreadFeed's estimatedItemSize
const DRAW_DISTANCE = 500 // ThreadFeed's drawDistance
const VIEWPORT = 800
const SHORT_HEIGHT = 48 // a one-line reply with its margin
const LONG_HEIGHT = 12_000 // 60,000 characters of prose

describe('the installed list estimates unmeasured rows by type', () => {
  test('3.3.5 keeps a running average per type and caches a container type until the data or function changes', () => {
    const version = JSON.parse(readFileSync(join(LEGEND_LIST, 'package.json'), 'utf8')).version
    expect(version).toBe('3.3.5')
    const bundle = readFileSync(join(LEGEND_LIST, 'react-native.js'), 'utf8')
    // Each line is matched alone, so a failure names the missing line and not the whole bundle.
    const missing = [
      // Positions are laid out with type averages for rows that have no size yet.
      'const useAverageSize = true;',
      'const averageSizeForType = (_c = averageSizes[itemType]) == null ? void 0 : _c.avg;',
      // A row measured again moves its type's average by the difference, under the type it was measured with.
      'averages.avg += (size - prevSizeKnown) / averages.num;',
      '=== state.dataChangeEpoch && previousMetadata.getItemType === getItemType && previousMetadata.itemData === itemData',
    ].filter((line) => !bundle.includes(line))
    expect(missing).toEqual([])
  })
})

/** The 3.3.5 estimator (`getItemSize`, `updateOneItemSize`) with fixture heights. */
class TypeAverages {
  private readonly averages = new Map<string, { avg: number; num: number }>()
  private readonly known = new Map<string, number>()

  estimate(id: string, type: string): number {
    return this.known.get(id) ?? this.averages.get(type)?.avg ?? ESTIMATED_ITEM_SIZE
  }

  isMeasured(id: string): boolean {
    return this.known.has(id)
  }

  measure(id: string, type: string, size: number): void {
    const previous = this.known.get(id)
    this.known.set(id, size)
    let averages = this.averages.get(type)
    if (!averages) this.averages.set(type, (averages = { avg: 0, num: 0 }))
    if (averages.num === 0) {
      averages.avg = size
      averages.num++
    } else if (previous !== undefined && previous > 0) {
      averages.avg += (size - previous) / averages.num
    } else {
      averages.avg = (averages.avg * averages.num + size) / (averages.num + 1)
      averages.num++
    }
  }
}

interface FixtureRow {
  readonly row: ThreadFeedRow
  readonly item: TranscriptItem
  readonly height: number
}

function reply(id: string, text: string, height: number): FixtureRow {
  return { row: { type: 'message', id, role: 'assistant', showMeta: false }, item: { kind: 'assistant', id, text }, height }
}

const roleOnlyType = (fixture: FixtureRow) => (fixture.row.type === 'message' ? `message:${fixture.row.role}` : fixture.row.type)
const sizeClassType = (fixture: FixtureRow) => threadFeedItemType(fixture.row, fixture.item, false)

/**
 * Mounts history above an anchor that the list holds in place
 * (maintainVisibleContentPosition). A pass mounts every unmeasured row the
 * estimates put inside the draw window above the anchor and measures it; a
 * measured row can pull the next one in. Each pass is one more nested commit.
 */
function settleAbove(rows: readonly FixtureRow[], anchor: number, windowAbove: number, typeOf: (row: FixtureRow) => string, sizes: TypeAverages) {
  let passes = 0
  let anchorCorrection = 0
  let top = anchor
  for (;;) {
    let offset = 0
    const mount: number[] = []
    for (let index = anchor - 1; index >= 0 && offset < windowAbove; index--) {
      const row = rows[index]!
      if (!sizes.isMeasured(row.row.id)) mount.push(index)
      offset += sizes.estimate(row.row.id, typeOf(row))
    }
    if (mount.length === 0) return { passes, anchorCorrection, top }
    passes++
    for (const index of mount) {
      const row = rows[index]!
      anchorCorrection += Math.abs(sizes.estimate(row.row.id, typeOf(row)) - row.height)
      sizes.measure(row.row.id, typeOf(row), row.height)
      top = Math.min(top, index)
    }
  }
}

/** Earlier short replies load above long ones, then the reader scrolls to the top. */
function prependShortAboveLong(typeOf: (row: FixtureRow) => string) {
  const long = Array.from({ length: 4 }, (_, index) => reply(`long-${index}`, 'Long handbook paragraph. '.repeat(2_400), LONG_HEIGHT))
  const short = Array.from({ length: 80 }, (_, index) => reply(`short-${index}`, `Short reply ${index}`, SHORT_HEIGHT))
  const sizes = new TypeAverages()
  for (const row of long) sizes.measure(row.row.id, typeOf(row), row.height)
  const rows = [...short, ...long]
  let anchor = short.length
  let maxPasses = 0
  let totalPasses = 0
  let anchorCorrection = 0
  for (let step = 0; step < 100 && anchor > 0; step++) {
    const settled = settleAbove(rows, anchor, VIEWPORT + DRAW_DISTANCE, typeOf, sizes)
    maxPasses = Math.max(maxPasses, settled.passes)
    totalPasses += settled.passes
    anchorCorrection += settled.anchorCorrection
    if (settled.top === anchor) break
    anchor = settled.top
  }
  return { maxPasses, totalPasses, anchorCorrection: Math.round(anchorCorrection), reachedTop: anchor === 0, shortEstimate: sizes.estimate('unseen', typeOf(short[0]!)) }
}

describe('short history above long replies', () => {
  test('size classes mount earlier history in a few passes; one class per role mounts it row by row', () => {
    const roleOnly = prependShortAboveLong(roleOnlyType)
    const sizeClasses = prependShortAboveLong(sizeClassType)
    console.log(JSON.stringify({ probe: 'feed-prepend-short-above-long', roleOnly, sizeClasses }))
    expect(roleOnly.reachedTop && sizeClasses.reachedTop).toBe(true)
    // T3's browser test allows fewer than 8 nested commits for the same history.
    expect(sizeClasses.maxPasses).toBeLessThan(8)
    expect(roleOnly.maxPasses).toBeGreaterThan(sizeClasses.maxPasses * 3)
    // The anchor holds by absorbing estimate error; the size classes leave far less of it.
    expect(sizeClasses.anchorCorrection * 50).toBeLessThan(roleOnly.anchorCorrection)
  })
})

describe('a reply that streams', () => {
  /** Ten short replies, one reply streamed to LONG_HEIGHT under the class it mounted with, then 40 earlier short replies. */
  function streamThenPrepend(streamType: (row: FixtureRow, streaming: boolean) => string) {
    const sizes = new TypeAverages()
    const settled = Array.from({ length: 10 }, (_, index) => reply(`settled-${index}`, `Done ${index}`, SHORT_HEIGHT))
    for (const row of settled) sizes.measure(row.row.id, sizeClassType(row), row.height)
    // The container keeps the type it resolved when the reply mounted; tokens do not change the rows.
    const streamingRow = reply('streaming', 'Sure', SHORT_HEIGHT)
    const typeWhileStreaming = streamType(streamingRow, true)
    for (let height = SHORT_HEIGHT; height <= LONG_HEIGHT; height += 400) sizes.measure('streaming', typeWhileStreaming, height)
    // The turn ends: the rows change, the reply resolves its real class and is measured again.
    const finished = reply('streaming', 'Long handbook paragraph. '.repeat(2_400), LONG_HEIGHT)
    sizes.measure('streaming', streamType(finished, false), LONG_HEIGHT)
    const earlier = Array.from({ length: 40 }, (_, index) => reply(`earlier-${index}`, `Earlier ${index}`, SHORT_HEIGHT))
    const rows = [...earlier, ...settled, finished]
    const result = settleAbove(rows, earlier.length, VIEWPORT + DRAW_DISTANCE, sizeClassType, sizes)
    return { shortEstimate: Math.round(sizes.estimate('unseen', sizeClassType(earlier[0]!))), passes: result.passes }
  }

  test('its growth stays out of the short class it started in', () => {
    const withoutStreamingClass = streamThenPrepend((row) => threadFeedItemType(row.row, row.item, false))
    const withStreamingClass = streamThenPrepend((row, streaming) => threadFeedItemType(row.row, row.item, streaming))
    console.log(JSON.stringify({ probe: 'feed-streamed-reply-then-prepend', withoutStreamingClass, withStreamingClass }))
    expect(withStreamingClass.shortEstimate).toBe(SHORT_HEIGHT)
    expect(withoutStreamingClass.shortEstimate).toBeGreaterThan(SHORT_HEIGHT * 5)
    expect(withStreamingClass.passes).toBeLessThan(withoutStreamingClass.passes)
  })

  test('the streaming reply is the last agent message of an active turn, before only live rows', () => {
    const message = (id: string, role: 'user' | 'assistant'): ThreadFeedRow => ({ type: 'message', id, role, showMeta: false })
    const thinking: ThreadFeedRow = { type: 'thinking', id: 'live-activity-row', continuesWorkLog: false }
    const tools: ThreadFeedRow = { type: 'work-toggle', id: 'work', groupId: 'g', toolIds: ['t'], expanded: false, live: true, continuesWorkLog: false }
    expect(streamingMessageRowId([message('u', 'user'), message('a', 'assistant'), thinking], true)).toBe('a')
    // The feed puts the turn's image row after its reply, before the live slot.
    const images: ThreadFeedRow = { type: 'turn-images', id: 'images:turn', itemIds: ['a'] }
    expect(streamingMessageRowId([message('u', 'user'), message('a', 'assistant'), images, thinking], true)).toBe('a')
    expect(streamingMessageRowId([message('u', 'user'), message('a', 'assistant'), thinking], false)).toBeNull()
    // Tool work after the reply: the reply is finished.
    expect(streamingMessageRowId([message('a', 'assistant'), tools, thinking], true)).toBeNull()
    // A prompt waiting for its first reply.
    expect(streamingMessageRowId([message('a', 'assistant'), message('u', 'user'), thinking], true)).toBeNull()
  })
})

describe('feed size classes', () => {
  const assistant = (text: string): [ThreadFeedRow, TranscriptItem] => [{ type: 'message', id: 'a', role: 'assistant', showMeta: true }, { kind: 'assistant', id: 'a', text }]

  test('doubling text-length buckets from 2,000 characters; an empty or missing item is the shortest', () => {
    expect(threadFeedItemType(...assistant(''), false)).toBe('message:assistant:0')
    expect(threadFeedItemType(...assistant('x'.repeat(1_999)), false)).toBe('message:assistant:0')
    expect(threadFeedItemType(...assistant('x'.repeat(2_000)), false)).toBe('message:assistant:1')
    expect(threadFeedItemType(...assistant('x'.repeat(4_000)), false)).toBe('message:assistant:2')
    expect(threadFeedItemType(...assistant('x'.repeat(60_000)), false)).toBe('message:assistant:5')
    expect(threadFeedItemType({ type: 'message', id: 'gone', role: 'assistant', showMeta: false }, undefined, false)).toBe('message:assistant:0')
  })

  test('a prompt with attachments has its own class; prompts and replies never share one', () => {
    const row: ThreadFeedRow = { type: 'message', id: 'u', role: 'user', showMeta: true }
    const prompt: TranscriptItem = { kind: 'user', id: 'u', text: 'Look', delivery: 'sent', error: null, attachments: [] }
    expect(threadFeedItemType(row, prompt, false)).toBe('message:user:0')
    const withImage: TranscriptItem = { ...prompt, attachments: [{ kind: 'host-image', key: 'i', name: 'shot.png', hostPath: '/tmp/shot.png' }] }
    expect(threadFeedItemType(row, withImage, false)).toBe('message:user:0:attachments')
  })

  test('work, fold and live rows keep their row type, so expanding tools changes no message estimate', () => {
    const rows: ThreadFeedRow[] = [
      { type: 'work-toggle', id: 'w', groupId: 'g', toolIds: ['t'], expanded: true, live: false, continuesWorkLog: false },
      { type: 'work-details', id: 'w:details', groupId: 'g', toolIds: ['t'], continuesWorkLog: false },
      { type: 'run-fold', id: 'f', turnId: 't', label: 'Worked', expanded: false },
      { type: 'thinking', id: 'live', continuesWorkLog: false },
    ]
    expect(rows.map((row) => threadFeedItemType(row, undefined, false))).toEqual(['work-toggle', 'work-details', 'run-fold', 'thinking'])
  })
})
