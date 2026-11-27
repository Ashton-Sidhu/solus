import type { AppFileView } from '@solus/contracts/apps'
import { formatFileSize } from '../../../files/lib/non-text-file'
import { appTime } from '../../lib/app-view'

/**
 * The file browser of the Files section (docs/plans/apps.md §9.2) in plain
 * terms: which files show for a search, the filters (source and type), and an order, the figures
 * above the table, and the words of each column. Pure, so the rules are
 * tested without a host.
 */

/** Where a file came from: a person put it in, or the app's backend wrote it. */
export type FileSourceFilter = 'all' | 'uploaded' | 'written'
export type FileOrder = 'newest' | 'name' | 'largest'

export const FILE_ORDER_OPTIONS: { value: FileOrder; label: string }[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'name', label: 'Name' },
  { value: 'largest', label: 'Largest first' },
]

/** The rows the table shows at first, and how many more each Show more adds. */
export const FILE_PAGE = 50

/** The source choices of the Filters menu, with how many files each one holds. */
export function fileSourceOptions(files: readonly AppFileView[]): { value: FileSourceFilter; label: string; count: number }[] {
  const uploaded = files.filter((file) => file.createdBy === 'ui').length
  return [
    { value: 'all', label: 'Any source', count: files.length },
    { value: 'uploaded', label: 'Uploaded', count: uploaded },
    { value: 'written', label: 'Written by the app', count: files.length - uploaded },
  ]
}

/** The type choices of the Filters menu: each type the files have, the most common first, with its count. */
export function fileTypeOptions(files: readonly AppFileView[]): { value: string; label: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const file of files) {
    const name = fileTypeName(file)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const types = [...counts].sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b))
  return [{ value: 'all', label: 'Any type', count: files.length }, ...types.map(([name, count]) => ({ value: name, label: name, count }))]
}

/** What the Filters menu narrows the table to. */
export interface FileFilter {
  source: FileSourceFilter
  /** The type a file must have to show, as `fileTypeName` names it, or 'all'. */
  type: string
}

export const ALL_FILES: FileFilter = { source: 'all', type: 'all' }

/** How many filters of the Filters menu narrow the table: the count on its button. */
export function activeFileFilterCount(filter: FileFilter): number {
  return Number(filter.source !== 'all') + Number(filter.type !== 'all')
}

/** The files that match the search and the filters, in the chosen order. The same instant keeps a stable order by id. */
export function visibleFiles(files: readonly AppFileView[], query: string, filter: FileFilter, order: FileOrder): AppFileView[] {
  const needle = query.trim().toLowerCase()
  const shown = files.filter(
    (file) =>
      (filter.source === 'all' || (filter.source === 'uploaded') === (file.createdBy === 'ui')) &&
      (filter.type === 'all' || fileTypeName(file) === filter.type) &&
      (needle === '' || file.name.toLowerCase().includes(needle) || file.type.toLowerCase().includes(needle) || fileTypeName(file).toLowerCase().includes(needle)),
  )
  const compare: (a: AppFileView, b: AppFileView) => number =
    order === 'name'
      ? (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      : order === 'largest'
        ? (a, b) => b.size - a.size
        : (a, b) => b.createdAt - a.createdAt
  return shown.sort((a, b) => compare(a, b) || a.id.localeCompare(b.id))
}

/** One figure above the table: its value in large type, and the words under it. */
export interface FileFigure {
  value: string
  detail: string
}

/** The three figures above a table that has files: how many, how much, and the newest. */
export function fileFigures(files: readonly AppFileView[], nowMs = Date.now()): { count: FileFigure; size: FileFigure; newest: FileFigure } | null {
  if (files.length === 0) return null
  const total = files.reduce((sum, file) => sum + file.size, 0)
  const newest = files.reduce((best, file) => (file.createdAt > best.createdAt ? file : best))
  return {
    count: { value: String(files.length), detail: files.length === 1 ? 'file' : 'files' },
    size: { value: formatFileSize(total), detail: 'in total' },
    newest: { value: appTime(newest.createdAt, nowMs), detail: `newest, ${newest.name}` },
  }
}

/** The file's extension in capitals, or null when its name has none. */
function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase() : null
}

const TYPE_NAMES = new Map([['MD', 'Markdown'], ['TXT', 'Text'], ['JPG', 'JPEG'], ['HTM', 'HTML'], ['YML', 'YAML']])
const MEDIA_TYPE_NAMES = new Map([
  ['application/pdf', 'PDF'],
  ['text/csv', 'CSV'],
  ['text/markdown', 'Markdown'],
  ['text/plain', 'Text'],
  ['text/html', 'HTML'],
  ['application/json', 'JSON'],
  ['image/png', 'PNG'],
  ['image/jpeg', 'JPEG'],
  ['image/gif', 'GIF'],
  ['image/webp', 'WebP'],
  ['image/svg+xml', 'SVG'],
])

/** The file's type as a person names it: "PDF", "Markdown". The extension speaks when the media type says nothing. */
export function fileTypeName(file: Pick<AppFileView, 'name' | 'type'>): string {
  const known = MEDIA_TYPE_NAMES.get(file.type.split(';')[0]!.trim().toLowerCase())
  if (known) return known
  const extension = extensionOf(file.name)
  if (extension) return TYPE_NAMES.get(extension) ?? extension
  return file.type === 'application/octet-stream' || file.type === '' ? 'File' : file.type
}

/** The tone of a file's type tile: one hue for each family of files, so a column of them reads at a glance. */
export type FileTileTone = 'document' | 'data' | 'image' | 'markup' | 'plain'

/** The tile beside a file's name: a short label of its type, in the tone of its family. */
export interface FileTypeTile {
  label: string
  tone: FileTileTone
}

export function fileTypeTile(file: Pick<AppFileView, 'name' | 'type'>): FileTypeTile {
  const type = file.type.toLowerCase()
  const extension = extensionOf(file.name)
  const label = (extension ?? (type.startsWith('image/') ? 'IMG' : 'FILE')).slice(0, 4)
  if (type === 'application/pdf' || extension === 'PDF') return { label: 'PDF', tone: 'document' }
  if (type.startsWith('image/')) return { label, tone: 'image' }
  if (type === 'text/csv' || type === 'application/json' || extension === 'CSV' || extension === 'JSON' || extension === 'XLSX') return { label, tone: 'data' }
  if (type === 'text/html' || extension === 'HTML' || extension === 'XML') return { label, tone: 'markup' }
  return { label, tone: 'plain' }
}

/** The Source column: a person put the file in, or the app wrote it. */
export function fileSourceText(createdBy: AppFileView['createdBy']): string {
  return createdBy === 'ui' ? 'Uploaded' : 'Written by the app'
}

const ORIGIN_TEXT = {
  ui: 'uploaded',
  agent: 'written by an agent',
  schedule: 'written by a schedule',
  webhook: 'written by a webhook',
  workflow: 'written by a workflow',
  model: 'written by a model call',
} satisfies { [Kind in AppFileView['createdBy']]: string }

/** The inspector's line under the name: "PDF · written by a schedule". */
export function fileOriginText(file: Pick<AppFileView, 'name' | 'type' | 'createdBy'>): string {
  return `${fileTypeName(file)} · ${ORIGIN_TEXT[file.createdBy]}`
}

const DAY = 86_400_000

/** The Added column: how long ago in the last day, else the date. */
export function fileAddedText(at: number, nowMs: number): string {
  if (nowMs - at < DAY) return appTime(at, nowMs)
  const date = new Date(at)
  const sameYear = date.getFullYear() === new Date(nowMs).getFullYear()
  return date.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}

/** The inspector's Added: "Today, 09:02", or the date and the time. */
export function fileAddedLongText(at: number, nowMs: number): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (date.toDateString() === new Date(nowMs).toDateString()) return `Today, ${time}`
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}, ${time}`
}

/** A long id cut in its middle, "f_8k2q…x41": the whole id is copied. */
export function shortFileId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 6)}…${id.slice(-3)}`
}
