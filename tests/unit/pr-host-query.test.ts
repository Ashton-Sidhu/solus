import { describe, expect, test } from 'bun:test'
import { hostSearchQuery, withMenuQualifiers } from '@solus/client-core/pr-host-query'
import { prMenuQualifiers } from '@solus/workspace-ui/components/prs/lib/pr-filter-menu'
import { parsePrSearchQuery } from '@solus/workspace-ui/components/prs/lib/pr-search-query'
import { pullRequestHostQuery } from '../../apps/mobile/src/features/prs/lib/pull-request-list'

const menu = (choices: { author?: string | null; label?: string | null; draft?: 'all' | 'ready' | 'draft' }) =>
  prMenuQualifiers({ author: null, label: null, draft: 'all', ...choices })

describe('filter menu choices reach the host', () => {
  test('a menu label, author and draft become host qualifiers', () => {
    // WHY: filtering only the loaded rows left a filtered page with two rows
    // out of a hundred. The host must narrow every page it reads.
    expect(hostSearchQuery(withMenuQualifiers(parsePrSearchQuery(''), menu({ label: 'needs design', author: 'octo', draft: 'ready' }))))
      .toBe('label:"needs design" author:octo draft:false')
    expect(hostSearchQuery(withMenuQualifiers(parsePrSearchQuery(''), menu({ draft: 'draft' })))).toBe('draft:true')
  })

  test('no menu choice keeps the ordinary listing', () => {
    // WHY: an empty host query is the signal to read the listing, not search.
    expect(hostSearchQuery(withMenuQualifiers(parsePrSearchQuery('  '), menu({})))).toBe('')
  })

  test('labels add up, and a typed author or draft wins over the menu', () => {
    // WHY: every label group must hold, but the host takes one author and one
    // draft state; two would ask for something no pull request can be.
    const query = withMenuQualifiers(parsePrSearchQuery('label:bug author:me draft:true fix'), menu({ label: 'ui', author: 'octo', draft: 'ready' }))
    expect(hostSearchQuery(query)).toBe('label:"bug" label:"ui" author:@me draft:true fix')
  })

  test('mobile sends its label, author and draft filters with the typed text', () => {
    // WHY: the phone list must read the same narrowed pages as web; review and
    // checks still narrow on the device, so they stay out of the host query.
    expect(pullRequestHostQuery('login', { labels: [['bug', 'p1']], excludedLabels: ['wip'], author: 'me', draft: 'only', review: 'approved' }))
      .toBe('label:"bug","p1" -label:"wip" author:@me draft:true login')
    expect(pullRequestHostQuery('', {})).toBe('')
  })
})
