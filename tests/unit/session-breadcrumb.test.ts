import { describe, expect, it } from 'bun:test'
import {
  projectNote,
  statusColor,
} from '../../src/renderer/components/conversation/lib/session-breadcrumb'

describe('statusColor', () => {
  it('distinguishes user attention, provider delay, active work, and failure', () => {
    // Rate limiting is not a permission request. Giving it the sidebar's amber
    // prevents two different kinds of interruption from sharing one colour.
    expect(statusColor('question')).toBe('var(--solus-status-permission)')
    expect(statusColor('limit')).toBe('var(--chart-2)')
    expect(statusColor('running')).toBe('var(--solus-status-running-icon)')
    expect(statusColor('error')).toBe('var(--solus-status-error)')
  })
})

describe('projectNote', () => {
  it('reports what you can act on over what already stopped', () => {
    // A project with both is still primarily a queue of decisions; the failures
    // are already over and will still be there after the questions are answered.
    expect(projectNote(2, 3)).toEqual({ text: '2 need you', tone: 'primary' })
    expect(projectNote(0, 3)).toEqual({ text: '3 failed', tone: 'destructive' })
  })

  it('agrees with itself about one', () => {
    expect(projectNote(1, 0)?.text).toBe('1 needs you')
  })

  it('stays silent when a project wants nothing', () => {
    expect(projectNote(0, 0)).toBeNull()
  })
})
