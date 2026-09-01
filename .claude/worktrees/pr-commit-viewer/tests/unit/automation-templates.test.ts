import { describe, expect, test } from 'bun:test'
import { AUTOMATION_TEMPLATES } from '../../src/renderer/components/automations/lib/automation-templates'

describe('automation templates', () => {
  test('keeps template ids unique', () => {
    const ids = AUTOMATION_TEMPLATES.map((template) => template.id)

    expect(new Set(ids).size).toBe(ids.length)
  })

  test('offers a weekly Luna maintenance pass with guarded cleanup', () => {
    const maintenance = AUTOMATION_TEMPLATES.find(
      (template) => template.id === 'computer-maintenance',
    )

    expect(maintenance).toBeDefined()
    expect(maintenance?.agentProvider).toBe('codex')
    expect(maintenance?.modelId).toBe('gpt-5.6-luna')
    expect(maintenance?.trigger).toEqual({ type: 'cron', expr: '0 3 * * 0' })
    expect(maintenance?.prompt).toContain('Never kill by name or pattern')
    expect(maintenance?.prompt).toContain('broader user caches')
    expect(maintenance?.prompt).toContain('further opportunities')
  })

  test('offers a Friday noon report covering the last week across all projects', () => {
    const report = AUTOMATION_TEMPLATES.find((template) => template.id === 'weekly-work-report')

    expect(report).toBeDefined()
    expect(report?.trigger).toEqual({ type: 'cron', expr: '0 12 * * 5' })
    expect(report?.prompt).toContain('past seven days')
    expect(report?.prompt).toContain('across all projects and worktrees')
    expect(report?.prompt).toContain('suitable to send directly to a manager')
  })

  test('keeps the codebase audit manual and read-only', () => {
    const audit = AUTOMATION_TEMPLATES.find((template) => template.id === 'codebase-audit')

    expect(audit).toBeDefined()
    expect(audit?.trigger).toEqual({ type: 'manual' })
    expect(audit?.prompt).toContain('This is a read-only audit')
    expect(audit?.prompt).toContain('cite the relevant file paths and symbols')
  })
})
