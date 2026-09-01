import { describe, expect, it } from 'bun:test'
import {
  breadcrumbLeafLabels,
  breadcrumbTaskGroups,
  breadcrumbTaskMatches,
  completedSectionExpanded,
  projectNote,
  statusColor,
} from '@solus/workspace-ui/components/conversation/lib/session-breadcrumb'

describe('breadcrumbTaskGroups', () => {
  it('puts unfinished work before completed work without changing either order', () => {
    // WHY: a long searchable picker must keep actionable work above its archive,
    // while the sidebar store remains the owner of urgency within each section.
    const groups = breadcrumbTaskGroups([
      { id: 'running', status: 'running' as const },
      { id: 'done-old', status: 'done' as const },
      { id: 'idle', status: 'idle' as const },
      { id: 'done-new', status: 'done' as const },
    ])

    expect(groups.open.map((task) => task.id)).toEqual(['running', 'idle'])
    expect(groups.completed.map((task) => task.id)).toEqual(['done-old', 'done-new'])
  })
})

describe('breadcrumbTaskMatches', () => {
  it('matches task names without case sensitivity or surrounding query spaces', () => {
    expect(breadcrumbTaskMatches('Remote Session Creation Hang', ' session ')).toBe(true)
    expect(breadcrumbTaskMatches('Remote Session Creation Hang', 'resolved')).toBe(false)
  })
})

describe('completedSectionExpanded', () => {
  it('keeps the archive folded until it is asked for', () => {
    // WHY: the picker exists to reach open work. Completed tasks stay out of the
    // way while no query names them.
    expect(completedSectionExpanded(null, '', 4)).toBe(false)
    expect(completedSectionExpanded(null, 'reconnect', 0)).toBe(false)
  })

  it('opens itself for a query that has matches inside it', () => {
    expect(completedSectionExpanded(null, 'reconnect', 2)).toBe(true)
  })

  it('lets a click fold a search open, and forgets it on the next keystroke', () => {
    // WHY: the click has to win over the auto-open, or the control looks dead
    // mid-search; but the decision belongs to that query, not to the next one.
    expect(completedSectionExpanded({ query: 'recon', expanded: false }, 'recon', 2)).toBe(false)
    expect(completedSectionExpanded({ query: 'recon', expanded: false }, 'reconn', 2)).toBe(true)
  })

  it('lets a click open the archive with no query at all', () => {
    expect(completedSectionExpanded({ query: '', expanded: true }, '', 4)).toBe(true)
  })
})

describe('breadcrumbLeafLabels', () => {
  it('names each kind of draft path without duplicating placeholder labels', () => {
    expect(breadcrumbLeafLabels('Fix reconnect', 'Session', 'existing-task')).toEqual({
      task: 'Fix reconnect',
      session: 'New session',
    })
    expect(breadcrumbLeafLabels('Session', 'Session', 'new-task')).toEqual({
      task: 'New task',
      session: 'New session',
    })
    expect(breadcrumbLeafLabels('Session', 'Session', 'no-task')).toEqual({
      task: null,
      session: 'New session',
    })
  })
})

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
