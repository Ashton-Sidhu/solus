import { describe, expect, test } from 'bun:test'
import { pullRequestFixture } from './__fixtures__/pull-request'
import {
  hostSearchQuery,
  matchesPrQualifiers,
  matchesPrText,
  parsePrSearchQuery,
  rankPrMatches,
} from '@solus/workspace-ui/components/prs/lib/pr-search-query'

describe('pull request search qualifiers', () => {
  test('reads GitHub qualifiers out of the typed text and keeps the rest as text', () => {
    // WHY: a project's labels are its own and no menu can list them, so the
    // field has to take GitHub's own syntax; what is not a qualifier is still
    // the words being searched for.
    expect(parsePrSearchQuery('fix login label:bug -label:"needs design" author:me draft:false review:approved status:success')).toEqual({
      text: 'fix login',
      qualifiers: {
        labels: [['bug']],
        excludedLabels: ['needs design'],
        author: 'me',
        draft: 'hide',
        review: 'approved',
        checks: 'passing',
      },
    })
  })

  test('an unknown key is a namespaced label, and quoting or a bad value keeps it text', () => {
    // WHY: repositories namespace labels with a colon (`size:XXL`); someone
    // typing one means the label. Quoting is the way back to literal text, and
    // a known key with a value it does not take must not vanish from the search.
    expect(parsePrSearchQuery('size:S,XS').qualifiers.labels).toEqual([['size:S', 'size:XS']])
    expect(parsePrSearchQuery('"size:XXL"')).toEqual({ text: '"size:XXL"', qualifiers: {} })
    expect(parsePrSearchQuery('draft:maybe').text).toBe('draft:maybe')
    expect(parsePrSearchQuery('https://github.com/acme/repo').text).toBe('https://github.com/acme/repo')
  })

  test('the host is asked in its own syntax, with author:me resolved by the host', () => {
    // WHY: the viewer's login is per host; `@me` lets GitHub answer who "me" is
    // instead of the client guessing for a host it may not know the viewer on.
    expect(hostSearchQuery(parsePrSearchQuery('author:me label:bug,wip review:changes-requested login'))).toBe(
      'label:"bug","wip" author:@me review:changes_requested login',
    )
    expect(hostSearchQuery(parsePrSearchQuery('   '))).toBe('')
  })

  test('qualifiers narrow the rows already on screen while the host is asked', () => {
    // WHY: the page keeps its rows during a search instead of blanking, so the
    // rows it keeps must already honour what was typed.
    const mine = pullRequestFixture(1, { author: 'sidhu', labels: [{ name: 'bug', color: 'f00' }] })
    const draft = pullRequestFixture(2, { author: 'alex', draft: true })
    const { qualifiers } = parsePrSearchQuery('author:me label:bug')
    expect(matchesPrQualifiers(mine, qualifiers, 'sidhu')).toBe(true)
    expect(matchesPrQualifiers(mine, qualifiers, null)).toBe(false)
    expect(matchesPrQualifiers(draft, parsePrSearchQuery('draft:true').qualifiers, null)).toBe(true)
    expect(matchesPrQualifiers(mine, parsePrSearchQuery('-label:bug').qualifiers, null)).toBe(false)
  })

  test('local text matches every field a row shows, branch and repository included', () => {
    const pr = pullRequestFixture(42, { title: 'Fold the header', headRef: 'solus/collapse-toolbar' })
    expect(matchesPrText(pr, 'collapse-toolbar')).toBe(true)
    expect(matchesPrText(pr, 'acme/repo')).toBe(true)
    expect(matchesPrText(pr, '#42')).toBe(true)
    expect(matchesPrText(pr, 'unrelated')).toBe(false)
  })
})

describe('pull request search relevance', () => {
  test('orders by how well a row answers the words, not by recency', () => {
    // WHY: the host matches bodies and comments a row does not show; ordering
    // by recency alone put apparently unrelated rows above the obvious one.
    // Every row here is newer than the one ranked above it.
    const rows = [
      pullRequestFixture(1, { title: 'Refactor store', updatedAt: '2026-09-06T00:00:00Z' }),
      pullRequestFixture(2, { title: 'Wizard cleanup', updatedAt: '2026-09-05T00:00:00Z' }),
      pullRequestFixture(3, { title: 'Wizard for the welcome screen', updatedAt: '2026-09-04T00:00:00Z' }),
      pullRequestFixture(4, { title: 'Add welcome wizard step', updatedAt: '2026-09-03T00:00:00Z' }),
      pullRequestFixture(5, { title: 'Welcome wizard', updatedAt: '2026-09-02T00:00:00Z' }),
    ]
    // exact title > title contains > every word > any word > the host's say-so
    expect(rankPrMatches(rows, 'welcome wizard').map((pr) => pr.number)).toEqual([5, 4, 3, 2, 1])
  })

  test('after the title, a match on branch outranks author, which outranks repository', () => {
    const rows = [
      pullRequestFixture(1, { title: 'Unrelated', updatedAt: '2026-09-06T00:00:00Z' }),
      pullRequestFixture(2, { title: 'Unrelated', baseRepo: { host: 'github.com', owner: 'acme', repo: 'wizard' }, updatedAt: '2026-09-05T00:00:00Z' }),
      pullRequestFixture(3, { title: 'Unrelated', author: 'wizard', updatedAt: '2026-09-04T00:00:00Z' }),
      pullRequestFixture(4, { title: 'Unrelated', headRef: 'wizard-setup', updatedAt: '2026-09-03T00:00:00Z' }),
      pullRequestFixture(5, { title: 'The wizard', updatedAt: '2026-09-02T00:00:00Z' }),
    ]
    expect(rankPrMatches(rows, 'wizard').map((pr) => pr.number)).toEqual([5, 4, 3, 2, 1])
  })

  test('a number is asked for exactly, and ties fall back to the most recently updated', () => {
    const target = pullRequestFixture(12, { title: 'Twelve', updatedAt: '2026-01-01T00:00:00Z' })
    const other = pullRequestFixture(120, { title: 'One hundred twenty', updatedAt: '2026-09-01T00:00:00Z' })
    expect(rankPrMatches([other, target], '#12').map((pr) => pr.number)).toEqual([12, 120])
    const older = pullRequestFixture(7, { title: 'Fix login', updatedAt: '2026-01-01T00:00:00Z' })
    const newer = pullRequestFixture(8, { title: 'Fix login', updatedAt: '2026-02-01T00:00:00Z' })
    expect(rankPrMatches([older, newer], 'fix login').map((pr) => pr.number)).toEqual([8, 7])
  })
})
