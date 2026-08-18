import { describe, expect, test } from 'bun:test'
import {
  columnEmphasis,
  columnGrows,
  columnTrack,
} from '../../src/renderer/components/insights/lib/table-grid'

// `select *` returns twenty columns of wildly different content. These tests
// encode the rules that keep such a result readable: a column's width starts
// from what it holds, and leftover room goes to the columns that were
// truncating rather than pooling between two numbers.

describe('result column widths', () => {
  test('prose and paths get room to be read; a status does not take it', () => {
    const command = columnTrack({ name: 'command', numeric: false })
    const status = columnTrack({ name: 'status', numeric: false, format: 'status' })
    const plain = columnTrack({ name: 'origin', numeric: false })
    expect(command).toBeGreaterThan(plain)
    expect(status).toBeLessThan(plain)
  })

})

// A table whose columns need less room than its card has must put the leftover
// somewhere. Left to the browser it lands between two numbers, so a prompt
// truncates beside four columns of blank. It is given away instead — only to
// the columns that can read more.
describe('leftover width', () => {
  const columns = [
    { name: 'started_at', numeric: true, format: 'time' as const },
    { name: 'session_id', numeric: false },
    { name: 'command', numeric: false },
    { name: 'duration_ms', numeric: true, format: 'duration' as const },
  ]

  test('the prose column takes the room; the instant, the id, and the measure do not', () => {
    expect(columnGrows(columns[2], columns)).toBe(true)
    expect(columnGrows(columns[0], columns)).toBe(false)
    expect(columnGrows(columns[1], columns)).toBe(false)
    expect(columnGrows(columns[3], columns)).toBe(false)
  })

  test('with nothing to read in place, the id column absorbs it instead', () => {
    const noProse = [
      { name: 'session_id', numeric: false },
      { name: 'runs', numeric: true },
    ]
    expect(columnGrows(noProse[0], noProse)).toBe(true)
    expect(columnGrows(noProse[1], noProse)).toBe(false)
  })

  test('a row of nothing but measures keeps every column at its own width', () => {
    const measures = [
      { name: 'calls', numeric: true },
      { name: 'total_ms', numeric: true, format: 'duration' as const },
    ]
    expect(measures.some((column) => columnGrows(column, measures))).toBe(false)
  })
})

// Emphasis is what stops a fifty-row answer reading as a wall of characters.
// It follows what a column is *for*, so the same question ranks the same way
// in both grids that render it.
describe('column emphasis', () => {
  test('what the row is about leads; how it is found again recedes', () => {
    expect(columnEmphasis({ name: 'command', numeric: false })).toBe('primary')
    expect(columnEmphasis({ name: 'prompt', numeric: false })).toBe('primary')
    expect(columnEmphasis({ name: 'session_id', numeric: false })).toBe('secondary')
    expect(columnEmphasis({ name: 'started_at', numeric: true, format: 'time' })).toBe(
      'secondary',
    )
  })

  test('a measure keeps the text colour, because it is what is being compared', () => {
    expect(columnEmphasis({ name: 'duration_ms', numeric: true, format: 'duration' })).toBe(
      'measure',
    )
    expect(columnEmphasis({ name: 'exit_code', numeric: true })).toBe('measure')
  })

  test('an instant is never a measure, however numeric its epoch is', () => {
    expect(columnEmphasis({ name: 'started_at', numeric: true, format: 'time' })).not.toBe(
      'measure',
    )
  })
})
