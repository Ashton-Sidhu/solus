import { describe, expect, it } from 'bun:test'
import {
  ALL_MODELS_LABEL,
  LEGACY_MODELS_LABEL,
  contextFact,
  filterModelGroups,
  groupModels,
} from '../../apps/client/src/shell/mobile/lib/mobile-model-groups'

/**
 * The mobile model sheet exists to answer "which one" in two taps rather than a
 * scroll. One rule carries that: the model already in use is lifted out of the
 * list. Everything else is a single list, the same shape for every agent —
 * splitting Claude by family gave one agent a different sheet from the other.
 */

const CLAUDE = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
]

describe('groupModels', () => {
  it('lifts the current model to the top under its own label', () => {
    const groups = groupModels('claude-code', CLAUDE, 'claude-opus-5-5')
    expect(groups[0]?.label).toBe('In this session')
    expect(groups[0]?.models.map((model) => model.id)).toEqual(['claude-opus-5-5'])
  })

  it('never lists the current model twice', () => {
    const groups = groupModels('claude-code', CLAUDE, 'claude-opus-5-5')
    const ids = groups.flatMap((group) => group.models.map((model) => model.id))
    expect(ids.filter((id) => id === 'claude-opus-5-5')).toHaveLength(1)
    expect(new Set(ids).size).toBe(CLAUDE.length)
  })

  it('leaves the current generation as one list in the provider order, not a card per family', () => {
    // One heading for the generation on offer, whichever agent is active.
    // Grouping Claude by family gave it four cards where Codex has one.
    const groups = groupModels('claude-code', CLAUDE, 'claude-sonnet-5')
    expect(groups.map((group) => group.label)).toEqual([
      'In this session',
      ALL_MODELS_LABEL,
      LEGACY_MODELS_LABEL,
    ])
    expect(groups[1]?.models.map((model) => model.label)).toEqual(['Opus 5.5', 'Haiku 4.5'])
  })

  it('takes the superseded generation off the main list into its own section', () => {
    const groups = groupModels('claude-code', CLAUDE, 'claude-sonnet-5')
    const legacy = groups.find((group) => group.isLegacy)
    expect(legacy?.label).toBe(LEGACY_MODELS_LABEL)
    expect(legacy?.models.map((model) => model.id)).toEqual(['claude-opus-4-8'])
    // Only the legacy section is marked, so only it renders behind a disclosure.
    expect(groups.filter((group) => group.isLegacy)).toHaveLength(1)
  })

  it('keeps the session’s own model visible even when it is a legacy one', () => {
    // The disclosure starts closed, so a session running a superseded model
    // would otherwise open a sheet that never names what it is running.
    const groups = groupModels('claude-code', CLAUDE, 'claude-opus-4-8')
    expect(groups[0]?.label).toBe('In this session')
    expect(groups[0]?.isLegacy).toBeUndefined()
    expect(groups[0]?.models.map((model) => model.id)).toEqual(['claude-opus-4-8'])
    expect(groups.find((group) => group.isLegacy)).toBeUndefined()
  })

  it('omits the legacy section when the agent has no superseded models', () => {
    const current = CLAUDE.filter((model) => model.id !== 'claude-opus-4-8')
    const groups = groupModels('claude-code', current, null)
    expect(groups.map((group) => group.label)).toEqual([ALL_MODELS_LABEL])
  })

  it('opens on the full list when nothing is selected yet', () => {
    const groups = groupModels('claude-code', CLAUDE, null)
    expect(groups.map((group) => group.label)).toEqual([ALL_MODELS_LABEL, LEGACY_MODELS_LABEL])
    expect(groups.flatMap((group) => group.models)).toHaveLength(CLAUDE.length)
  })
})

describe('contextFact', () => {
  it('states the window in the units people say it in', () => {
    // The one fact that decides between two models in a family. A raw
    // 1000000 is not a fact anyone reads at 10px.
    expect(contextFact('claude-code', 'claude-opus-5')).toBe('1M context')
    expect(contextFact('claude-code', 'claude-haiku-4-5-20251001')).toBe('200k context')
  })

  it('says nothing for a model the profile table does not know', () => {
    expect(contextFact('claude-code', 'not-a-model')).toBe('')
  })
})

describe('filterModelGroups', () => {
  const groups = groupModels('claude-code', CLAUDE, 'claude-opus-5-5')

  it('matches the fact as well as the name', () => {
    // "1M" is how someone looks for a long-context model when they cannot
    // remember which family has one.
    const long = filterModelGroups(groups, '1M')
    expect(long.flatMap((group) => group.models).length).toBeGreaterThan(0)
    expect(long.flatMap((group) => group.models).every((model) => model.fact.includes('1M'))).toBe(true)
  })

  it('drops groups that have nothing left rather than leaving empty headings', () => {
    const sonnet = filterModelGroups(groups, 'sonnet')
    expect(sonnet.every((group) => group.models.length > 0)).toBe(true)
    expect(sonnet.flatMap((group) => group.models).map((model) => model.label)).toEqual(['Sonnet 5'])
  })

  it('returns everything for an empty query', () => {
    expect(filterModelGroups(groups, '   ')).toEqual(groups)
  })

  it('keeps the legacy section marked so a match does not lose its disclosure', () => {
    // The sheet opens the section for as long as a filter is on, and closes it
    // again afterwards — which it can only do if the flag survives the filter.
    const matched = filterModelGroups(groups, '4.8')
    expect(matched.map((group) => group.label)).toEqual([LEGACY_MODELS_LABEL])
    expect(matched[0]?.isLegacy).toBe(true)
  })
})
