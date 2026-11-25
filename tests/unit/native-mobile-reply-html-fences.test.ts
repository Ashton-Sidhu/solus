import { describe, expect, test } from 'bun:test'
import { replyHtmlLayout, replySegments } from '@solus/document-model/reply-html-layout'

const PAGE = '<style>p{color:red}</style><p>Chart</p>'
const kinds = (markdown: string) => replySegments(markdown).map((segment) => segment.kind)

describe('native reply: live HTML fences', () => {
  test('a closed page fence becomes a page between the prose, as on desktop and web', () => {
    const segments = replySegments(`Here it is:\n\n\`\`\`html\n${PAGE}\n\`\`\`\n\nDone.`)
    expect(segments).toEqual([
      { kind: 'markdown', key: 'md:0', text: 'Here it is:\n\n' },
      { kind: 'html', key: 'html:13', html: PAGE },
      { kind: 'markdown', key: expect.stringMatching(/^md:/), text: '\n\nDone.' },
    ])
  })

  test('a fence that is still streaming stays code, so the frame is not built per token', () => {
    expect(kinds(`Here:\n\n\`\`\`html\n${PAGE}`)).toEqual(['markdown'])
  })

  test('markup to read stays code; the info string overrides the content test', () => {
    expect(kinds('```html\n<div>broken template</div>\n```')).toEqual(['markdown'])
    expect(kinds('```html render\n<div>card</div>\n```')).toEqual(['html'])
    expect(kinds(`\`\`\`html source\n${PAGE}\n\`\`\``)).toEqual(['markdown'])
  })

  test('a page fence inside a list, a quote, or another fence stays code', () => {
    expect(kinds(`- item\n\n  \`\`\`html\n  ${PAGE}\n  \`\`\``)).toEqual(['markdown'])
    expect(kinds(`> \`\`\`html\n> ${PAGE}\n> \`\`\``)).toEqual(['markdown'])
    expect(kinds(`\`\`\`\`markdown\n\`\`\`html\n${PAGE}\n\`\`\`\n\`\`\`\``)).toEqual(['markdown'])
  })

  test('a page keeps its key while the reply streams on after it', () => {
    const head = `\`\`\`html\n${PAGE}\n\`\`\`\n\nMore`
    const before = replySegments(head).find((segment) => segment.kind === 'html')
    const after = replySegments(`${head} text and a second paragraph.`).find((segment) => segment.kind === 'html')
    expect(after?.key).toBe(before!.key)
  })

  test('a reply with no page is one Markdown part with the same text', () => {
    expect(replySegments('Plain **reply**.')).toEqual([{ kind: 'markdown', key: 'md:0', text: 'Plain **reply**.' }])
  })
})

test('the host sends frame offsets without repeating the HTML or moving surrounding Markdown', () => {
  const markdown = ['💬 Before', '', '```html', PAGE, '```', '', 'After', '', '```html source', PAGE, '```'].join('\n')
  const frames = replyHtmlLayout(markdown, () => 'diagram')
  expect(frames).toHaveLength(1)
  const frame = frames![0]!
  expect(markdown.slice(frame.bodyStart, frame.bodyEnd)).toBe(PAGE)
  expect(frame).toMatchObject({ attachmentId: 'diagram', height: 320 })
  expect(JSON.stringify(frames)).not.toContain(PAGE)
  const display = (parts: ReturnType<typeof replySegments>) => parts.map(part =>
    part.kind === 'html' ? part.html : part.kind === 'markdown' ? part.text : part.guide)
  expect(display(replySegments(markdown, frames))).toEqual(display(replySegments(markdown)))
  expect(replyHtmlLayout('```html\n' + PAGE, () => 'incomplete')).toBeUndefined()
})
