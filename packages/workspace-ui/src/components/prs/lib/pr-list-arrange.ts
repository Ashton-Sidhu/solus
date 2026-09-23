/**
 * The pull request list from loaded rows to what is drawn, in order:
 *
 *  1. **searched** — rows in the fetch scope that match the typed search. The
 *     typed text only narrows until the host has answered it (the host reads
 *     bodies and comments a row does not show); the qualifiers always hold.
 *  2. **filtered** — the page's State and Filters menus on top.
 *  3. **ordered** — the chosen sort; a search under merge readiness is
 *     ordered by how well each row answers it instead.
 *  4. **sections** — Authored, Review requested, Others for the unnarrowed
 *     list; one flat section otherwise.
 *
 * Pure, so the page reads it from one `$derived`.
 */
import type { PullRequest } from '@solus/contracts/providers'
import { filterPrFacets, filterPrs, sortPrs, type PrChecksState } from './pr-utils'
import { matchesPrQualifiers, rankPrMatches, type PrSearchQuery } from './pr-search-query'
import {
  flatPrSection,
  prFetchScope,
  prSections,
  prStatusOf,
  showsPrSections,
  type PrListView,
  type PrRowContext,
  type PrSection,
} from './prs-list-view'

export interface PrListFacts {
  rowContext: PrRowContext
  viewerLogin: (pr: PullRequest) => string | null
  checksState: (pr: PullRequest) => PrChecksState | null
  hasGuide: (pr: PullRequest) => boolean
}

export interface ArrangedPrList {
  searched: PullRequest[]
  filtered: PullRequest[]
  sectioned: boolean
  sections: PrSection[]
}

export function arrangePrList(
  items: PullRequest[],
  listView: PrListView,
  search: { typed: PrSearchQuery; hostAnswered: boolean },
  facts: PrListFacts,
): ArrangedPrList {
  const statuses = new Set(listView.statusKeys)
  const searched = filterPrs(items, search.hostAnswered ? '' : search.typed.text, prFetchScope(listView.statusKeys))
    .filter((pr) => matchesPrQualifiers(pr, search.typed.qualifiers, facts.viewerLogin(pr)))
  const filtered = filterPrFacets(
    searched.filter((pr) => statuses.has(prStatusOf(pr))),
    listView,
    { viewerLogin: facts.viewerLogin, checksState: facts.checksState, hasGuide: facts.hasGuide },
  )
  const ordered = search.typed.text.trim() && listView.sortMode === 'ready'
    ? rankPrMatches(filtered, search.typed.text)
    : sortPrs(filtered, listView.sortMode, facts.checksState)
  const sectioned = showsPrSections(listView.involvement, listView.query)
  return {
    searched,
    filtered,
    sectioned,
    sections: sectioned ? prSections(ordered, facts.rowContext) : flatPrSection(ordered),
  }
}
