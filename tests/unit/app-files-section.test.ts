import { describe, expect, test } from 'bun:test'
import type { AppFileView } from '@solus/contracts/apps'
import { uploadsHeading } from '@solus/workspace-ui/components/app/manage/lib/app-file-transfer'
import {
  fileAddedText,
  fileFigures,
  fileOriginText,
  fileSourceOptions,
  fileSourceText,
  fileTypeName,
  fileTypeTile,
  shortFileId,
  visibleFiles,
} from '@solus/workspace-ui/components/app/manage/lib/app-file-list'
import { filePreviewKind, PREVIEW_MAX_BYTES } from '@solus/workspace-ui/components/app/manage/lib/app-file-preview'

const file = (id: string, name: string, size: number, createdAt: number, createdBy: AppFileView['createdBy'], type = 'text/csv'): AppFileView => ({ id, name, type, size, createdAt, createdBy })

describe('the table of the Files section', () => {
  const files = [
    file('a', 'report-10.csv', 300, 3, 'ui'),
    file('b', 'report-9.csv', 100, 1, 'schedule'),
    file('c', 'photo.png', 900, 2, 'agent', 'image/png'),
  ]

  test('a search matches the name, the media type, or the type a person reads, in any case', () => {
    // WHY: an owner finds "the images" or "the PNGs" by type as often as a file by its name.
    expect(visibleFiles(files, 'REPORT', 'all', 'newest').map((f) => f.id)).toEqual(['a', 'b'])
    expect(visibleFiles(files, 'image/', 'all', 'newest').map((f) => f.id)).toEqual(['c'])
    expect(visibleFiles(files, 'png', 'all', 'newest').map((f) => f.id)).toEqual(['c'])
  })

  test('the source splits what people uploaded from what the app wrote', () => {
    expect(visibleFiles(files, '', 'uploaded', 'newest').map((f) => f.id)).toEqual(['a'])
    expect(visibleFiles(files, '', 'written', 'newest').map((f) => f.id)).toEqual(['c', 'b'])
    expect(fileSourceOptions(files).map((option) => [option.label, option.count])).toEqual([['All', 3], ['Uploaded', 1], ['Written by the app', 2]])
    expect([fileSourceText('ui'), fileSourceText('workflow')]).toEqual(['Uploaded', 'Written by the app'])
  })

  test('the orders: newest first, names as a person counts, largest first', () => {
    expect(visibleFiles(files, '', 'all', 'newest').map((f) => f.id)).toEqual(['a', 'c', 'b'])
    // report-9 comes before report-10, as Finder sorts them.
    expect(visibleFiles(files, '', 'all', 'name').map((f) => f.id)).toEqual(['c', 'b', 'a'])
    expect(visibleFiles(files, '', 'all', 'largest').map((f) => f.id)).toEqual(['c', 'a', 'b'])
  })

  test('the figures count the files, add their sizes, and name the newest', () => {
    const figures = fileFigures(files, 60_000)
    expect(figures?.count).toEqual({ value: '3', detail: 'files' })
    expect(figures?.size).toEqual({ value: '1.3 KB', detail: 'in total' })
    expect(figures?.newest.detail).toBe('newest, report-10.csv')
    expect(fileFigures([file('x', 'one.txt', 1, 1, 'ui')])?.count.detail).toBe('file')
    expect(fileFigures([])).toBeNull()
  })

  test('a file’s type reads as a person names it; a type that says nothing reads as the extension', () => {
    expect(fileTypeName({ name: 'notes.md', type: 'text/markdown' })).toBe('Markdown')
    expect(fileTypeName({ name: 'digest.pdf', type: 'application/pdf' })).toBe('PDF')
    expect(fileTypeName({ name: 'dump.sqlite', type: 'application/octet-stream' })).toBe('SQLITE')
    expect(fileTypeName({ name: 'notes.md', type: 'application/octet-stream' })).toBe('Markdown')
    expect(fileTypeName({ name: 'blob', type: 'application/octet-stream' })).toBe('File')
    expect(fileTypeTile({ name: 'digest.pdf', type: 'application/pdf' })).toEqual({ label: 'PDF', tone: 'document' })
    expect(fileTypeTile({ name: 'email-template.html', type: 'text/html' })).toEqual({ label: 'HTML', tone: 'markup' })
    expect(fileTypeTile({ name: 'logo', type: 'image/png' })).toEqual({ label: 'IMG', tone: 'image' })
  })

  test('the inspector says which caller wrote a file, and the id is cut only in its middle', () => {
    expect(fileOriginText(file('d', 'digest.pdf', 1, 1, 'schedule', 'application/pdf'))).toBe('PDF · written by a schedule')
    expect(shortFileId('f_8k2qz7mm3x41')).toBe('f_8k2q…x41')
    expect(shortFileId('f_short')).toBe('f_short')
  })

  test('Added says how long ago within a day, and the date after that', () => {
    const now = Date.UTC(2026, 10, 15, 12)
    expect(fileAddedText(now - 2 * 3_600_000, now)).toBe('2 hr ago')
    expect(fileAddedText(now - 3 * 86_400_000, now)).not.toContain('ago')
  })

  test('the upload head counts the files that go, and after, the ones that did not arrive', () => {
    const going = [{ size: 10, sentBytes: 10, error: null }, { size: 10, sentBytes: 2, error: null }, { size: 10, sentBytes: 0, error: 'Too large' }]
    expect(uploadsHeading(going, true)).toBe('Uploading 2 of 2')
    expect(uploadsHeading([{ size: 10, sentBytes: 0, error: 'Too large' }], false)).toBe('1 file was not uploaded')
  })
})

describe('the preview of the Files section', () => {
  test('images and PDFs preview; other files, empty files, and large files show the file glyph', () => {
    // WHY: the preview reads the whole file over the app's call; a bound keeps a click from reading many megabytes.
    expect(filePreviewKind({ name: 'logo.png', type: 'image/png', size: 86_000 })).toBe('image')
    expect(filePreviewKind({ name: 'digest.pdf', type: 'application/pdf', size: 1_200_000 })).toBe('pdf')
    expect(filePreviewKind({ name: 'digest.pdf', type: 'application/octet-stream', size: 1_200_000 })).toBe('pdf')
    expect(filePreviewKind({ name: 'repos.csv', type: 'text/csv', size: 4_000 })).toBeNull()
    expect(filePreviewKind({ name: 'empty.png', type: 'image/png', size: 0 })).toBeNull()
    expect(filePreviewKind({ name: 'huge.png', type: 'image/png', size: PREVIEW_MAX_BYTES + 1 })).toBeNull()
  })
})
