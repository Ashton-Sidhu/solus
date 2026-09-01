import { describe, expect, test } from 'bun:test'
import type { MetricsQueryResult } from '@solus/contracts/observability-types'
import { numericColumns } from '@solus/workspace-ui/components/insights/lib/result-columns'

// A result column carries the type the field registry declares for it. That
// declaration is what says whether a column holds a quantity — the chart shapes
// and the event table read it instead of inspecting the cells.
//
// Only a column the query invented — an aliased aggregate, a computed
// expression — arrives without one, and only those are classified by reading
// every row. These tests pin which path each takes, because the difference is
// both a correctness rule (a declared column of nulls is still numeric) and the
// reason a view listing renders without scanning its own result.

function result(columns: MetricsQueryResult['columns'], rows: MetricsQueryResult['rows']): MetricsQueryResult {
  return { columns, rows }
}

describe('numeric columns', () => {
  test('a declared column answers from its own type, not from its cells', () => {
    // Every cell is null, so a scan would call this column non-numeric and the
    // grid would left-align a column of measurements.
    const declared = result(
      [{ name: 'cost_usd', type: 'number' }, { name: 'model', type: 'string' }],
      [[null, 'opus'], [null, 'sonnet']],
    )

    expect(numericColumns(declared)).toEqual([true, false])
  })

  test('a declared duration is a quantity', () => {
    const declared = result([{ name: 'duration_ms', type: 'duration' }], [[1_200]])

    expect(numericColumns(declared)).toEqual([true])
  })

  test('a declared string column stays non-numeric even when it holds digits', () => {
    // `session_id` is text that happens to look numeric in this result; the
    // declaration is what keeps it out of the charts' measure candidates.
    const declared = result([{ name: 'session_id', type: 'string' }], [['12345'], ['67890']])

    expect(numericColumns(declared)).toEqual([false])
  })

  test('an aliased aggregate has no declaration, so its cells are read', () => {
    const aliased = result([{ name: 'total_seconds' }, { name: 'label' }], [[41.2, 'a'], [18.7, 'b']])

    expect(numericColumns(aliased)).toEqual([true, false])
  })

  test('an undeclared column of only nulls is not numeric — nothing says it is', () => {
    const aliased = result([{ name: 'total_seconds' }], [[null], [null]])

    expect(numericColumns(aliased)).toEqual([false])
  })
})
