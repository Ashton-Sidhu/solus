import { describe, expect, test } from 'bun:test'
import { compileNlToSql, extractSql, nlCompileSystemPrompt } from '../../src/main/observability/nl-compile'
import type { MetricsSqlValidation } from '../../src/shared/observability-types'

const ok: MetricsSqlValidation = { ok: true, columns: ['n'] }

describe('extractSql', () => {
  test('strips markdown fences and surrounding whitespace', () => {
    expect(extractSql('```sql\nSELECT 1\n```')).toBe('SELECT 1')
    expect(extractSql('Here you go:\n```\nSELECT 2\n```')).toBe('SELECT 2')
    expect(extractSql('  SELECT 3  ')).toBe('SELECT 3')
  })
})

describe('compileNlToSql', () => {
  test('returns on the first valid attempt', async () => {
    const prompts: string[] = []
    const result = await compileNlToSql('how many turns ran today?', {
      generate: async (prompt) => {
        prompts.push(prompt)
        return 'SELECT COUNT(*) AS n FROM turns'
      },
      validate: () => ok,
    })
    expect(result).toEqual({ sql: 'SELECT COUNT(*) AS n FROM turns', ok: true, attempts: 1 })
    expect(prompts).toEqual(['how many turns ran today?'])
  })

  test('retries with the SQLite error text until the SQL prepares', async () => {
    const prompts: string[] = []
    let calls = 0
    const result = await compileNlToSql('question', {
      generate: async (prompt) => {
        prompts.push(prompt)
        calls++
        return calls === 1 ? '```sql\nSELECT nope FROM turns\n```' : 'SELECT COUNT(*) AS n FROM turns'
      },
      validate: (sql) => sql.includes('nope')
        ? { ok: false, error: 'no such column: nope' }
        : ok,
    })
    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(2)
    expect(prompts[1]).toContain('no such column: nope')
    expect(prompts[1]).toContain('SELECT nope FROM turns')
  })

  test('gives up after bounded attempts, returning the last SQL and error', async () => {
    const result = await compileNlToSql('question', {
      generate: async () => 'SELECT broken',
      validate: () => ({ ok: false, error: 'syntax error' }),
    })
    expect(result).toEqual({ sql: 'SELECT broken', ok: false, error: 'syntax error', attempts: 3 })
  })

  test('the system prompt carries the generated view schema', () => {
    const prompt = nlCompileSystemPrompt()
    expect(prompt).toContain('CREATE VIEW turns')
    expect(prompt).toContain('CREATE VIEW events')
    expect(prompt).toContain('cost_usd')
    // The pre-summed child time is the reason most questions need no join —
    // the agent must be told it exists.
    expect(prompt).toContain('tool_time_ms')
  })
})
