import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { commentCheckpoint } from '@solus/server/google/docs-comment-checkpoint'
const previous = process.env.SOLUS_DATA_DIR
let directory: string | undefined
afterEach(async () => {
  if (previous === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previous
  if (directory) await rm(directory, { recursive: true, force: true })
})
test('stale Google quotes follow a verified local edit across restart and uncertain delivery', async () => {
  directory = await mkdtemp(join(tmpdir(), 'solus-quote-checkpoint-'))
  process.env.SOLUS_DATA_DIR = directory
  const before = '\0The date is Friday.\n', after = '\0The date is Monday.\n'
  const comments = [{ id: 'native', quote: 'The date is Friday.' }]
  const checkpoint = await commentCheckpoint('doc', 'tab', before, comments)
  await checkpoint.save([
    { deleteContentRange: { range: { startIndex: 13, endIndex: 16, tabId: 'tab' } } },
    { insertText: { location: { index: 13, tabId: 'tab' }, text: 'Mon' } },
  ])
  expect((await commentCheckpoint('doc', 'tab', before, comments)).quotes).toEqual(['The date is Friday.'])
  expect((await commentCheckpoint('doc', 'tab', after, comments)).quotes).toEqual(['The date is Monday.'])
  // A collaborator edit, different document, or reused quote under another
  // thread cannot inherit a remembered range.
  expect((await commentCheckpoint('doc', 'tab', after + 'Other edit.', comments)).quotes).toEqual(['The date is Friday.'])
  expect((await commentCheckpoint('other', 'tab', after, comments)).quotes).toEqual(['The date is Friday.'])
  expect((await commentCheckpoint('doc', 'tab', after, [{ id: 'other', quote: comments[0].quote }])).quotes).toEqual(['The date is Friday.'])
})

test('structural index changes and a later quote edit share one recoverable checkpoint', async () => {
  directory = await mkdtemp(join(tmpdir(), 'solus-quote-structure-'))
  process.env.SOLUS_DATA_DIR = directory
  const before = '\0The date is Friday.\n', added = '\0\0\n'
  const comments = [{ id: 'native', quote: 'The date is Friday.' }]
  const checkpoint = await commentCheckpoint('doc', 'tab', before, comments)
  await checkpoint.save([
    { deleteContentRange: { range: { startIndex: 16, endIndex: 19, tabId: 'tab' } } },
    { insertText: { location: { index: 16, tabId: 'tab' }, text: 'Mon' } },
  ], [{ start: 1, end: 1, text: added }])
  const after = '\0' + added + 'The date is Monday.\n'
  expect((await commentCheckpoint('doc', 'tab', after, comments)).quotes).toEqual(['The date is Monday.'])
  expect((await commentCheckpoint('doc', 'tab', before, comments)).quotes).toEqual(['The date is Friday.'])
})
