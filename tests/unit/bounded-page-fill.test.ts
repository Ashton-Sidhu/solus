import { describe, expect, test } from 'bun:test'
import { BoundedPageFill, PAGE_FILL_MAX_READS, PAGE_FILL_MIN_ROWS } from '@solus/client-core/bounded-page-fill'

const short = { rows: 2, hasMore: true, reading: false }

describe('a filtered page fills itself', () => {
  test('reads more pages while the page is short and the host has more', () => {
    // WHY: a filter only loaded rows can answer thins out each page; without
    // this the rest appeared only after an overscroll nobody would try.
    const fill = new BoundedPageFill()
    expect(fill.next('list', short)).toBe(true)
  })

  test('stops after five reads, so a filter that matches nothing does not walk the whole history', () => {
    const fill = new BoundedPageFill()
    const reads = Array.from({ length: PAGE_FILL_MAX_READS + 3 }, () => fill.next('list', short)).filter(Boolean)
    expect(reads).toHaveLength(PAGE_FILL_MAX_READS)
  })

  test('a new list or filter starts the count again', () => {
    // WHY: the bound is per question; a new filter deserves its own reads.
    const fill = new BoundedPageFill()
    for (let read = 0; read < PAGE_FILL_MAX_READS; read++) fill.next('review:approved', short)
    expect(fill.next('review:approved', short)).toBe(false)
    expect(fill.next('checks:failing', short)).toBe(true)
  })

  test('reads nothing while a read is on its way, when the page is full, or when nothing is left', () => {
    // WHY: a second read on the wire would ask for the same page twice, and a
    // page that already shows enough rows needs no help.
    const fill = new BoundedPageFill()
    expect(fill.next('list', { ...short, reading: true })).toBe(false)
    expect(fill.next('list', { ...short, rows: PAGE_FILL_MIN_ROWS })).toBe(false)
    expect(fill.next('list', { ...short, hasMore: false })).toBe(false)
    // None of those counted against the bound.
    const reads = Array.from({ length: PAGE_FILL_MAX_READS }, () => fill.next('list', short)).filter(Boolean)
    expect(reads).toHaveLength(PAGE_FILL_MAX_READS)
  })
})
