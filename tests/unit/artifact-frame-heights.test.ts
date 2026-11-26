import { afterEach, describe, expect, jest, test } from 'bun:test'
import { Marked } from 'marked'
import type { WireSessionLoadMessage } from '@solus/contracts/session-history'
import { recordArtifactFrameHeight, withFrameHeight, withReplyHtmlLayouts } from '@solus/server/data/works/artifact-layout'
import { frameHeightReporter, storedHeightAt } from '../../packages/workspace-ui/src/components/artifact/lib/artifact-view'
import { replyFrameLayoutOf } from '../../packages/workspace-ui/src/components/conversation/lib/reply-frame-layout'

// WHY: a reply's HTML frame grows when its render reports a height, and an
// opening conversation hides its rows until it does (up to 300 ms). A client
// remembered heights only in its own browser, so another device, the web
// client, or an evicted entry paid that wait on every open. The host keeps
// the height one client measured, and every later open sizes the frame first.

const HTML = '<style>.chart { height: 400px }</style><div class="chart">Chart</div>'
const reply = (text: string): WireSessionLoadMessage => ({ role: 'assistant', content: text, timestamp: 1 })
const REPLY = `Here is the chart.\n\n\`\`\`html\n${HTML}\n\`\`\`\n\nIt shows the trend.`

afterEach(() => jest.useRealTimers())

describe('the host keeps a height a client measured', () => {
  test('a reported height comes back with the reply on the next history read', async () => {
    const [before] = await withReplyHtmlLayouts([reply(REPLY)])
    const frame = before.replyHtmlLayout![0]
    expect(frame.heights).toBeUndefined()

    await recordArtifactFrameHeight(frame.attachmentId, 736, 412)
    const [after] = await withReplyHtmlLayouts([reply(REPLY)])
    expect(after.replyHtmlLayout![0].heights).toEqual([[736, 412]])
  })

  test('a known width takes the new height, and a full set drops the width nearest the new one', () => {
    expect(withFrameHeight([[375, 900], [736, 400]], 738, 410)).toEqual([[375, 900], [738, 410]])
    const full = Array.from({ length: 12 }, (_, index): [number, number] => [300 + index * 50, 100])
    const next = withFrameHeight(full, 612, 222)
    expect(next).toHaveLength(12)
    expect(next).toContainEqual([612, 222])
    expect(next.some(([width]) => width === 600)).toBe(false)
  })
})

describe('the client sizes a frame from the stored height for its width', () => {
  test('only a height measured at nearly the same width is used', () => {
    const heights = [[375, 900], [736, 400]] as const
    expect(storedHeightAt(heights, 738)).toBe(400)
    expect(storedHeightAt(heights, 600)).toBeUndefined()
    expect(storedHeightAt(heights, 0)).toBeUndefined()
  })

  test('the height a frame rests on is sent once per width, and not when the host already has it', () => {
    jest.useFakeTimers()
    const sent: Array<[number, number]> = []
    const report = frameHeightReporter([[736, 400]], async (width, height) => { sent.push([width, height]) })

    report(736, 120); report(736, 400.4)
    jest.advanceTimersByTime(1000)
    expect(sent).toEqual([])

    report(640, 300); report(640, 520)
    jest.advanceTimersByTime(1000)
    report(640, 520)
    jest.advanceTimersByTime(1000)
    expect(sent).toEqual([[640, 520]])
  })

  test('the fence text the transcript renders finds the frame the host identified', async () => {
    const [read] = await withReplyHtmlLayouts([reply(REPLY)])
    const message = { content: read.content, replyHtmlLayout: read.replyHtmlLayout }
    const fence = new Marked({ gfm: true }).lexer(REPLY).find((token) => token.type === 'code')
    if (fence?.type !== 'code') throw new Error('expected the html fence')
    expect(replyFrameLayoutOf(message, fence.text)?.attachmentId).toBe(read.replyHtmlLayout![0].attachmentId)
    // A reply whose text changed since the read matches no frame.
    expect(replyFrameLayoutOf({ ...message, content: `${message.content} more` }, '<div>other</div>')).toBeUndefined()
  })
})
