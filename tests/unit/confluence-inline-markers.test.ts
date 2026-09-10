import { expect, test } from 'bun:test'
import { confluenceMarkerQuotes, preserveConfluenceMarkers, requireUniqueConfluenceQuote } from '@solus/server/docs/confluence/inline-markers'
const marked = (text: string, ref = 'review') => `<ac:inline-comment-marker ac:ref="${ref}">${text}</ac:inline-comment-marker>`

test('changed text retains its native marker ID over repeated publishing and refresh', () => {
  let body = `<p>${marked('The meeting starts at ten.')}</p><p>Owner: Maya.</p>`
  for (const time of ['eleven', 'noon', 'one']) {
    body = preserveConfluenceMarkers(body, `<p>The meeting starts at ${time}.</p><p>Owner: Sam.</p>`)
    expect(confluenceMarkerQuotes(body).get('review')).toBe(`The meeting starts at ${time}.`)
  }
})

test('keeps marker ranges across formatting, entities, emoji and table cells', () => {
  const before = `<table><tr><td><p>${marked('A &amp; B 😀 are ready.')}</p></td></tr></table>`
  const next = '<table><tr><td><p><strong>A &amp; B 😀</strong> are ready.</p></td></tr></table>'
  const actual = preserveConfluenceMarkers(before, next)
  expect(actual).toContain('<strong>')
  expect(confluenceMarkerQuotes(actual).get('review')).toBe('A & B 😀 are ready.')
  expect(confluenceMarkerQuotes(preserveConfluenceMarkers(actual, next)).get('review')).toBe('A & B 😀 are ready.')
})

test('unrelated inserted blocks do not move an unchanged marked block to another sentence', () => {
  const before = `<p>${marked('Target sentence.')}</p><p>Other.</p>`
  const next = '<p>New.</p><p>Target sentence.</p><p>Other.</p>'
  expect(confluenceMarkerQuotes(preserveConfluenceMarkers(before, next)).get('review')).toBe('Target sentence.')
})

test('refuses deleting, crossing, or ambiguously relocating an anchored range', () => {
  const before = `<p>Start ${marked('target')} end.</p>`
  for (const next of ['<p>Start end.</p>', '<p>Start replacement end.</p>', '<p>Start target end.</p><p>Start target end.</p>', '<p>Different content.</p>']) {
    expect(() => preserveConfluenceMarkers(before, next)).toThrow('Cannot keep')
  }
})

test('overlapping comments retain their own exact quotes', () => {
  const before = `<p>${marked('The '+marked('meeting', 'inner')+' starts at ten.')}</p>`
  const actual = preserveConfluenceMarkers(before, '<p>The meeting starts at eleven.</p>')
  expect(confluenceMarkerQuotes(actual).get('review')).toBe('The meeting starts at eleven.')
  expect(confluenceMarkerQuotes(actual).get('inner')).toBe('meeting')
})

test('unsupported marker locations stop publishing instead of dropping the marker', () => {
  expect(() => preserveConfluenceMarkers(`<ac:structured-macro>${marked('hidden')}</ac:structured-macro>`, '<p>Other</p>')).toThrow('Cannot keep')
})

test('inline creation accepts only one visible text occurrence', () => {
  requireUniqueConfluenceQuote('<p>A <strong>&amp; B</strong></p>', 'A & B')
  expect(() => requireUniqueConfluenceQuote('<p>Repeat</p><p>Repeat</p>', 'Repeat')).toThrow('repeated')
  expect(() => requireUniqueConfluenceQuote('<p title="hidden">Text</p>', 'hidden')).toThrow('missing')
})

test('same-page comment and publish operations serialize across instances and release after failure', async () => {
  const { withConfluencePage } = await import('@solus/server/docs/confluence/page-lock')
  const ref = { provider: 'confluence' as const, externalId: 'page', externalKey: 'site/SPACE', url: '' }
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const events: string[] = []
  const first = withConfluencePage(ref, async () => { events.push('create'); await barrier; events.push('marker saved'); throw new Error('read-back failed') })
  const second = withConfluencePage({ ...ref }, async () => { events.push('publish reads marker') })
  await Promise.resolve()
  expect(events).not.toContain('publish reads marker')
  release()
  await expect(first).rejects.toThrow('read-back failed')
  await second
  expect(events).toEqual(['create', 'marker saved', 'publish reads marker'])
})


test('decodes XHTML named entities when restoring current marked text', () => {
  const current = `<p>${marked('A&nbsp;B &amp; C')}</p>`
  expect(confluenceMarkerQuotes(current).get('review')).toBe('A\u00a0B & C')
  expect(confluenceMarkerQuotes(preserveConfluenceMarkers(current, '<p>A\u00a0B &amp; C</p>')).get('review')).toBe('A\u00a0B & C')
})

test('moving and editing a marked paragraph cannot attach its comment to an unchanged paragraph', () => {
  const before = `<p>${marked('The launch is Friday.')}</p><p>The owner is Maya.</p>`
  const after = '<p>The owner is Maya.</p><p>The launch is Monday.</p>'
  expect(() => preserveConfluenceMarkers(before, after)).toThrow('Cannot keep')
})

test('removing one of two identical paragraphs cannot choose which native comment survived', () => {
  const before = `<p>${marked('Same text.')}</p><p>Same text.</p>`
  expect(() => preserveConfluenceMarkers(before, '<p>Same text.</p>')).toThrow('Cannot keep')
})

test('format then edit maps adjacent fragments as one native range across repeated publishes', () => {
  let body = `<p>${marked('The meeting starts at ten.')}</p>`
  body = preserveConfluenceMarkers(body, '<p>The meeting starts at <strong>ten</strong>.</p>')
  for (const time of ['eleven', 'noon']) {
    body = preserveConfluenceMarkers(body, `<p>The meeting starts at <strong>${time}</strong>.</p>`)
    expect(confluenceMarkerQuotes(body).get('review')).toBe(`The meeting starts at ${time}.`)
    expect(body).toContain('<strong>')
  }
})

test('overlapping ranges still protect an inner comment after formatting splits both markers', () => {
  const body = `<p>${marked('The meeting '+marked('starts at ten', 'inner')+'.')}</p>`
  const formatted = preserveConfluenceMarkers(body, '<p>The <strong>meeting starts</strong> at ten.</p>')
  const edited = preserveConfluenceMarkers(formatted, '<p>The <strong>meeting starts</strong> around ten.</p>')
  expect(confluenceMarkerQuotes(edited).get('review')).toBe('The meeting starts around ten.')
  expect(confluenceMarkerQuotes(edited).get('inner')).toBe('starts around ten')
})

test('reads recover nested-list quotes and isolate unreadable markers without weakening publish guards', () => {
  const storage = `<ul><li>${marked('Parent item')}<ul><li>Child item</li></ul></li></ul>`
    + `<ac:structured-macro>${marked('Hidden', 'macro')}</ac:structured-macro>`
    + `<p>${marked('Other comment', 'other')}</p>`
  const quotes = confluenceMarkerQuotes(storage)
  expect(quotes.get('review')).toBe('Parent item')
  expect(quotes.get('other')).toBe('Other comment')
  expect(quotes.has('macro')).toBe(true)
  expect(quotes.get('macro')).toBeUndefined()
  expect(() => preserveConfluenceMarkers(storage, '<p>Other comment</p>')).toThrow('Cannot keep')
})
