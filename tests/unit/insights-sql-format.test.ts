import { describe, expect, test } from 'bun:test'
import { formatGeneratedSql } from '../../src/renderer/components/insights/lib/sql-format'

describe('Insights generated SQL formatting', () => {
  test('formats an NL-generated statement before it enters the editor', () => {
    expect(
      formatGeneratedSql(
        "SELECT model,COUNT(*) AS turns FROM turns WHERE started_at >= 1 GROUP BY model ORDER BY turns DESC",
      ),
    ).toBe(`select
  model,
  COUNT(*) as turns
from
  turns
where
  started_at >= 1
group by
  model
order by
  turns desc`)
  })

  test('keeps SQLite string content unchanged', () => {
    const formatted = formatGeneratedSql(
      "select count(*) from events where command = 'GROUP BY stays text'",
    )

    expect(formatted).toContain("'GROUP BY stays text'")
  })
})
